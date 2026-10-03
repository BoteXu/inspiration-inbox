export const PREFERENCES_KEY = 'shinian.model.preferences.v1';
export const MODEL_PRESETS = {
  custom:{label:'自定义兼容服务',endpoint:'',hint:'填写自己的兼容服务或可信网关。模板不代表已验证连接。'},
  deepseek:{label:'DeepSeek 官方接口模板',endpoint:'https://api.deepseek.com/chat/completions',hint:'填写服务当前支持的模型 ID。浏览器是否可直连仍需实际测试。'},
  ollama:{label:'Ollama 本机模板',endpoint:'http://localhost:11434/v1/chat/completions',hint:'填写已安装的模型名称。本机服务还需允许本站来源及浏览器本地网络访问。'},
  lmstudio:{label:'本机兼容服务模板',endpoint:'http://localhost:1234/v1/chat/completions',hint:'仅为常见本机地址格式示例，实际端口和模型以自己的服务为准。'},
};
export function validateConnection({endpoint,model,apiKey='',auto=false,expanded=false,preset='custom'}) {
  let url;try{url=new URL(endpoint.trim());}catch{throw new Error('请填写完整的模型接口地址');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new Error('模型服务请使用 HTTPS；本机服务可使用 localhost 或 127.0.0.1');
  if(url.username||url.password||url.search||url.hash)throw new Error('请不要在地址中包含密码、查询密钥或锚点');
  if(!url.pathname.endsWith('/chat/completions'))throw new Error('请填写完整的 Chat Completions 地址，以 /chat/completions 结尾');
  if(typeof model!=='string'||!model.trim()||model.length>120)throw new Error('请填写服务提供的模型名称');
  if(typeof apiKey!=='string'||apiKey.length>1000||/[\r\n]/.test(apiKey))throw new Error('密钥格式不正确');
  if(url.href.length>2000)throw new Error('接口地址过长');
  return {endpoint:url.href,model:model.trim(),apiKey:apiKey.trim(),auto:Boolean(auto),expanded:Boolean(expanded),preset:Object.hasOwn(MODEL_PRESETS,preset)?preset:'custom'};
}
export function publicPreferences(config) {
  const valid=validateConnection(config);
  // Deliberately whitelist: never persist keys or automatic-call authorization.
  return {endpoint:valid.endpoint,model:valid.model,preset:valid.preset,expanded:valid.expanded};
}
export function parsePreferences(text) {
  const input=JSON.parse(text);
  if(!input||typeof input!=='object')throw new Error('模型偏好格式不正确');
  return publicPreferences({endpoint:input.endpoint,model:input.model,preset:input.preset,expanded:input.expanded,apiKey:'',auto:false});
}
export class ModelError extends Error {
  constructor(message,code) {super(message);this.name='ModelError';this.code=code;}
}
export async function callChat(config,prompt,{signal,fetchImpl=fetch,test=false}={}) {
  const validated=validateConnection(config),headers={'Content-Type':'application/json'};
  if(validated.apiKey)headers.Authorization=`Bearer ${validated.apiKey}`;
  const timeout=AbortSignal.timeout(60000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{response=await fetchImpl(validated.endpoint,{method:'POST',headers,body:JSON.stringify({model:validated.model,messages:[{role:'user',content:prompt}],stream:false,max_tokens:test?64:2500}),credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:combined,cache:'no-store'});}catch(error){
    if(signal?.aborted)throw new Error('请求已取消；模型服务可能已经产生调用费用');
    if(timeout.aborted||error.name==='TimeoutError')throw new Error('模型在 60 秒内未返回；原话仍已保存，可以稍后重试');
    throw new ModelError('无法连接模型：可能是网络、跨域 CORS、地址或浏览器对本机服务的限制。页面无法区分这些原因；请检查自己的服务，或使用复制请求方式','network');
  }
  if(!response.ok){const messages={401:'密钥无效或没有权限',403:'服务拒绝访问，请检查密钥及服务权限',404:'接口地址或模型不存在',429:'服务额度不足或请求过于频繁'};throw new ModelError(messages[response.status]||`模型服务返回 HTTP ${response.status}，请到自己的服务检查状态`,String(response.status));}
  let text;
  try{text=await response.text();}catch{throw new ModelError('读取模型响应未完成；请手动重试，原话已保留','read');}
  if(text.length>300000)throw new Error('模型响应过大，请使用较短的输出');
  let data;try{data=JSON.parse(text);}catch{throw new Error('模型服务返回的内容不是 JSON 响应');}
  if(data.choices?.[0]?.finish_reason==='length')throw new Error('模型输出被截断，请重试或改用其他模型');
  const content=data.choices?.[0]?.message?.content;
  if(typeof content!=='string'||!content.trim()||content.length>50000)throw new Error('模型没有返回可用的文本，请确认接口兼容 Chat Completions');
  return content;
}
