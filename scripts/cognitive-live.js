import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { apiKeyEnvironment, profileArguments } from '../scripts/runtime-options.js';
import { secureDirectory, saveCredentials } from '../src/security.js';
import { DshClient } from '../src/dsh.js';
const root=path.resolve('.'); const base=path.join(root,'.research/cognitive-live',randomUUID());
// The runtime is already installed; tests get a separate home/data directory, never a duplicate SDK or working DSH.
const installed=path.join(root,'.runtime/node_modules/@deepseek-ai/dsh/package.json');
if(!fs.existsSync(installed)||JSON.parse(fs.readFileSync(installed,'utf8')).version!=='0.2.0-rc.2')throw Error('Run npm run dsh:setup for the pinned independent DSH first.');
const {createServer}=await import('node:net');
await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(Error('Cognitive test port 3098 is occupied.')));probe.listen(3098,'127.0.0.1',()=>probe.close(resolve));});
secureDirectory(base); const home=path.join(base,'home'); fs.mkdirSync(home); const dataDir=path.join(base,'data'); secureDirectory(dataDir);
const config={ dataDir,dsh:{baseUrl:'http://127.0.0.1:3098',cwd:path.join(base,'workspaces')},cognitive:{outputTokenBudget:1800,workerTimeoutMs:90000} };
fs.mkdirSync(config.dsh.cwd); const configFile=path.join(base,'config.json'); fs.writeFileSync(configFile,JSON.stringify(config));
const budgetPlugin=path.join(base,'budget.mjs'); fs.writeFileSync(budgetPlugin,"export function apply(ctx){ctx.on('agent/request',async(_p,next)=>({...await next(),maxTokens:500,reasoningEffort:'off'}));}");
const overlay=path.join(base,'patch.yml');
fs.writeFileSync(overlay,fs.readFileSync('dsh/weixin.patch.yml','utf8')
 .replace('__WEIXIN_POLICY__',JSON.stringify(pathToFileURL(path.join(root,'dsh/weixin-policy.js')).href))
 .replaceAll('__COGNITIVE_PLUGIN__',JSON.stringify(pathToFileURL(path.join(root,'dsh/cognitive.js')).href))
 .replace('          - id: questions','          - id: live-budget\n            name: '+JSON.stringify(pathToFileURL(budgetPlugin).href)+'\n          - id: questions'));
const env={...apiKeyEnvironment(root).env,DSH_HOME:home,DS_FRIEND_COGNITIVE:JSON.stringify({dir:path.join(dataDir,'cognitive'),config:config.cognitive})};
delete env.DSH_COOKIE;delete env.DSH_LAUNCH_TOKEN;delete env.DSH_WEB_URL;
const child=spawn(process.execPath,[path.join(root,'.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),...profileArguments(home),'--patch',overlay,'--host','127.0.0.1','--port','3098','--no-open'],{cwd:config.dsh.cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let text=''; let started=false; let readyResolve; let readyReject;
const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
const timer=setTimeout(()=>readyReject(Error('startup-timeout')),60000);
async function inspect(chunk){text=(text+chunk.toString()).slice(-20000);if(started)return;const m=text.match(/http:\/\/(?:127\.0\.0\.1|localhost):3098\/\?token=([A-Za-z0-9_-]+)/);if(!m)return;started=true;const client=new DshClient({baseUrl:config.dsh.baseUrl,launchToken:m[1],timeoutMs:15000});await client.auth();saveCredentials(dataDir,{baseUrl:config.dsh.baseUrl,cookie:client.cookie},'dsh-connection.json');text='';clearTimeout(timer);readyResolve();}
child.stdout.on('data',c=>inspect(c).catch(()=>readyReject(Error('auth-failed'))));child.stderr.on('data',c=>inspect(c).catch(()=>readyReject(Error('auth-failed'))));child.on('error',()=>readyReject(Error('spawn-failed')));child.on('exit',()=>{if(!started)readyReject(Error('early-exit'));});
try{await ready;console.log('isolated-cognitive-dsh-ready');const args=process.argv.includes('--evaluate')?['scripts/cognitive-evaluate.js',...process.argv.slice(2).filter(a=>a!=='--evaluate')]:['--test','tests/cognitive-live.test.js'];const proc=spawn(process.execPath,args,{cwd:root,env:{...process.env,RUN_COGNITIVE_LIVE:'1',COGNITIVE_LIVE_CONFIG:configFile},windowsHide:true,stdio:'inherit'});process.exitCode=await new Promise(r=>proc.once('exit',r));}
catch(e){console.error(e.message==='startup-timeout'?'isolated-startup-timeout':'isolated-startup-failed');process.exitCode=1;}
finally{clearTimeout(timer);child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));text='';}
