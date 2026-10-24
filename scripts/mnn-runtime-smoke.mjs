// Full installed DSH profile smoke, isolated home/data/port. No model prompt is submitted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadCredentials} from '../src/security.js';
import {DshClient} from '../src/dsh.js';
import {RuntimeStore} from '../src/runtime.js';
import {CognitiveStore} from '../src/cognitive/store.js';
import {loadConfig} from '../src/config.js';
const root=fileURLToPath(new URL('..',import.meta.url)),run=path.join(root,'.research/mnn-v120/runtime-'+randomUUID()),data=path.join(run,'data');
await fs.mkdir(path.join(data,'cognitive/mnn'),{recursive:true});
await fs.writeFile(path.join(data,'cognitive/mnn/activation.json'),JSON.stringify({schema:'dsf-mnn-activation/1',enabled:true,paused:true,runtimeVersion:'0.2.0-rc.2',tokenizer:path.join(root,'.research/mnn-v120/tokenizer')}));
const baseUrl='http://127.0.0.1:3094',config=path.join(run,'config.json');
await fs.writeFile(config,JSON.stringify({dataDir:data,dsh:{baseUrl,cwd:path.join(run,'workspace')},weixin:{enabled:false},qq:{enabled:false}}));
const child=spawn(process.execPath,['scripts/dsh.js','start'],{cwd:root,env:{...process.env,BRIDGE_CONFIG:config,BRIDGE_LAUNCHER:'1',DS_FRIEND_DSH_HOME:path.join(run,'home')},stdio:['pipe','pipe','pipe'],windowsHide:true});
let ready=false,exited=false;const codes=[];let buffer='';
child.on('exit',()=>exited=true);
child.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const entry=JSON.parse(line);if(entry.event==='dsh.independent-ready')ready=true;if(entry.code)codes.push(entry.code);}catch{}}});
child.stderr.on('data',()=>{});const report={run,prompt_submissions:0,production_written:false};let client;
try{
 const deadline=Date.now()+90000;while(!ready&&!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));
 if(!ready)throw Error('mnn-full-runtime-not-ready');
 const credential=loadCredentials(data,'dsh-connection.json');client=new DshClient({baseUrl,cookie:credential.cookie,timeoutMs:15000});
 await client.auth();const presets=await client.rpc('agentPresets/list',{});
 report.preset_count=Array.isArray(presets)?presets.length:Object.keys(presets??{}).length;
 const id=randomUUID();await client.rpc('session/create',{sessionId:id,cwd:path.join(run,'workspace'),agentPreset:'weixin'});
 report.agent_created=true;report.session_id=id;report.success=true;
 if(process.argv.includes('--live')){
  const c=loadConfig(config),runtime=new RuntimeStore(data),memory=new CognitiveStore(path.join(data,'cognitive'),c.cognitive);
  const request=randomUUID();runtime.configure({continuous:false,reasoningEffort:'off',maxTokens:512});runtime.bind(id,'isolated-full-profile','test',null,request);
  memory.bind(memory.scope(),id,'合成 MNN 插件验收','conversation',{displayName:'OTREE（合成测试）'});memory.close();
  const abort=new AbortController(),events=new Map();let timeout;
  const result=new Promise((resolve,reject)=>{
   timeout=setTimeout(()=>reject(Error('mnn-full-profile-turn-timeout')),120000);
   client.on('session',(sid,frame)=>{if(sid!==id)return;for(const row of frame.type==='snapshot'?frame.records??[]:frame.type==='event'?[frame]:[])events.set(row.event.seq,row.event);
    if([...events.values()].some(e=>e.type==='turn/end'))resolve();});
  });
  let connected;const ready=new Promise(resolve=>connected=resolve);client.once('connected',connected);const running=client.run(abort.signal);
  try{
   await ready;client.follow(id);report.prompt_submissions=1;
   await client.rpc('session/prompt',{sessionId:id,requestId:request,mode:'queue',content:[{type:'text',text:'这是隔离合成测试。只调用 memory_recall 查询 project port=3099，然后调用 take_rest 结束。不要发送消息或执行其他工具。'}],clientTimeZone:'Asia/Shanghai'});
   await result;const rows=[...events.values()].sort((a,b)=>a.seq-b.seq);
   report.turn_completed=rows.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind==='completed';
   report.mnn_tool_called=rows.some(e=>e.type==='tool/call'&&e.data.name==='memory_recall');
   report.mnn_context_assembled=rows.filter(e=>e.type==='user/message'&&e.data.source?.kind==='runtime-context').some(e=>JSON.stringify(e.data).includes('统一 MNN 记忆数据'));
   report.memory_role='user/runtime-context';
   report.self_commit_exposed=rows.filter(e=>e.type==='request/header').some(e=>(e.data.header?.tools??[]).some(t=>['self_model_commit','self_model_rollback'].includes(t.name)));
   report.emissions=runtime.db.prepare('SELECT count(*) n FROM emissions').get().n;
   report.success=report.turn_completed&&report.mnn_tool_called&&report.mnn_context_assembled&&!report.self_commit_exposed;
  }finally{clearTimeout(timeout);abort.abort();client.socket?.terminate();await running;runtime.close();}
 }
}catch(error){report.success=false;report.error=/^mnn-/.test(error.message??'')?error.message:'mnn-full-runtime-failed';report.codes=codes;}
finally{
 client?.close?.();child.stdin.write(JSON.stringify({command:'shutdown'})+'\n');
 const deadline=Date.now()+20000;while(!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 if(!exited){child.kill();report.shutdown_unconfirmed=true;report.success=false;}
 await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.success)process.exitCode=2;
}
