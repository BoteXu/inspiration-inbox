import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,relative} from 'node:path';
const root=new URL('../',import.meta.url);
const base=decodeURIComponent(root.pathname).replace(/^\/([A-Z]:)/,'$1');
const git=args=>{try{return execFileSync('git',args,{cwd:base,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '';}};
const remote=git(['remote','get-url','origin']);
const configuredName=git(['config','--global','user.name']),configuredEmail=git(['config','--global','user.email']);
const personalMarkers=[configuredName,configuredEmail,remote.match(/github\.com[/:]([^/]+)/)?.[1]].filter(value=>value&&value.length>3);
const files=[];
async function walk(path){for(const item of await readdir(path,{withFileTypes:true})){if(['.git','test-results','node_modules','backups'].includes(item.name))continue;const full=join(path,item.name);if(item.isDirectory())await walk(full);else if(/\.(?:js|mjs|json|md|html|css|yml|svg|webmanifest)$/.test(item.name))files.push(full);}}
await walk(base);
const findings=[];
for(const file of files){const text=await readFile(file,'utf8');if(personalMarkers.some(marker=>text.toLowerCase().includes(marker.toLowerCase())))findings.push({file:relative(base,file),issue:'personal identity marker'});if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text))findings.push({file:relative(base,file),issue:'possible embedded API credential'});}
// The owner explicitly permits their configured Git identity in commit metadata.
// Source files and credentials remain subject to the privacy checks above.
const allowedIdentities=new Set(['Project Maintainer|maintainer@users.noreply.github.com']);
if(configuredName&&configuredEmail)allowedIdentities.add(`${configuredName}|${configuredEmail}`);
const authors=git(['log','--all','--format=%an|%ae|%cn|%ce']).split('\n').filter(Boolean);
if(authors.some(row=>{const [name,email,committer,committerEmail]=row.split('|');return !allowedIdentities.has(`${name}|${email}`)||!allowedIdentities.has(`${committer}|${committerEmail}`);}))findings.push({issue:'unexpected commit identity in reachable history'});
if(findings.length){console.error(JSON.stringify({passed:false,findings},null,2));process.exitCode=1;}else console.log(JSON.stringify({passed:true,sourceFilesChecked:files.length,commitIdentityPolicy:'owner-configured identity permitted',secretValuesPrinted:false}));
