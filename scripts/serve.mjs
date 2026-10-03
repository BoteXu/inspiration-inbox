import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, relative, isAbsolute } from 'node:path';
const root=fileURLToPath(new URL('../site/',import.meta.url));
const types={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'text/javascript;charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const port=Number(process.env.PORT||4173);
createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://localhost'),path=decodeURIComponent(url.pathname),target=resolve(root,`.${path.endsWith('/')?`${path}index.html`:path}`),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel)){res.writeHead(403);res.end();return;}const file=await readFile(target);res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(file);}catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`拾念预览：http://127.0.0.1:${port}/`));
