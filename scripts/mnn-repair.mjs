// Invoked under mnn_admin's offline lock and verified-backup gate. No channels or tool executors.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createNativeKernel,registerRemoteProvider} from '../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';
import {mountMnn,exportSession} from '../dsh/mnn.js';
import {pressure} from '../src/mnn/guardian.js';

const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.argv.includes('--authorized-offline'))throw Error('mnn-offline-gate-required');
const [sid,data,tokenizer,backup]=process.argv.slice(2).filter(x=>!x.startsWith('--'));
if(!/^[a-f0-9-]{36}$/.test(sid??'')||!data||!tokenizer||!backup)throw Error('mnn-repair-arguments');
const run=path.join(root,'.research/mnn-v120/formal-'+randomUUID());await fs.mkdir(run,{recursive:true});
const report={schema:'dsf-mnn-formal-repair/1',session_id:sid,backup,run,started:new Date().toISOString(),prompt_submissions:0,external_tool_executors:0};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const selfDir=path.join(data,'cognitive/self');
async function selfDigest(){const files=await fs.readdir(selfDir,{recursive:true});const rows=[];for(const name of files.sort()){const file=path.join(selfDir,name);if((await fs.stat(file)).isFile())rows.push([name,createHash('sha256').update(await fs.readFile(file)).digest('hex')]);}return hash(rows);}
let kernel,mnn;
try{
 report.self_before=await selfDigest();
 kernel=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(root,'.runtime/home/sessions'));
 const handle=await kernel.persistence.open(sid,'read');let before,original;
 try{const stored=await handle.read();before={events:structuredClone(stored.events)};original=kernel.sessionModule.Session.create(sid,stored.events,handle.header,handle.inheritedEventCount);}finally{await handle.close();}
 report.events_before=before.events.length;report.prefix_digest=hash(before.events);
 // Retain the real system prompt and historical tool declarations in provider budget validation.
 const system=original.deriveMessages().filter(x=>x.role==='system').at(-1);
 if(!system)throw Error('mnn-original-system-unavailable');
 const tools=original.requestHeader()?.tools;if(!Array.isArray(tools))throw Error('mnn-original-tools-unavailable');
 kernel.ctx.tools.schemas=()=>structuredClone(tools);
 const window=Math.min(1000000,original.requestContext()?.contextWindow??1000000);
 await registerRemoteProvider(kernel,root,{contextWindow:window,maxTokens:8192,thinking:'enabled'});
 mnn=mountMnn(kernel.ctx,data,{enabled:true,paused:true,tokenizer});
 // Disable every wake path before native resume publishes the Agent. Do not replay any Inbox.
 kernel.ctx.on('agent/created',({agent})=>{agent.wakeDriver=()=>{};agent.followup=()=>{throw Error('mnn-repair-no-chat-submission');};});
 const owned=await kernel.loop.resume(kernel.ctx,{resumeSessionId:sid,agentOptions:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,reasoningEffort:'off'}});
 const agent=owned.agent;report.pending_before=agent.inbox.nextTurn.length+agent.inbox.nextStep.length;
 report.before_pressure=pressure(await mnn.measurement(agent));
 mnn.guardian.change(sid,'REST_PENDING','operator-mnn-repair',{attempts:0,retry_at:0,owner:null,lease:0});
 const result=await mnn.rest(agent);if(result?.state!=='NORMAL')throw Error(result?.error??'mnn-repair-did-not-complete');
 await kernel.ctx.sessions.flush(agent.session);
 const after=exportSession(agent.session);
 report.events_after=after.events.length;report.prefix_equal=isDeepStrictEqual(after.events.slice(0,before.events.length),before.events);
 report.after_pressure=pressure(await mnn.measurement(agent));
 report.system_preserved=isDeepStrictEqual(system,agent.session.deriveMessages().filter(x=>x.role==='system').at(-1));
 report.pending_after=agent.inbox.nextTurn.length+agent.inbox.nextStep.length;
 report.memory_state=await mnn.client.call('status');report.work=JSON.parse(mnn.guardian.get(sid).work??'{}');
 const prepared=await mnn.client.call('prepared',{run_id:report.work.run_id});
 report.memory_persisted=prepared.memoryPersisted;report.carryover_present=Boolean(prepared.carryover);report.self_update=prepared.self_update;
 report.self_after=await selfDigest();report.self_unchanged=report.self_after===report.self_before;
 report.success=report.prefix_equal&&report.system_preserved&&report.self_unchanged&&report.memory_persisted&&report.carryover_present&&report.after_pressure.ratio<=.60&&report.pending_before===report.pending_after;
 if(!report.success)throw Error('mnn-formal-postconditions');
}catch(error){report.success=false;report.error=/^mnn-[-a-z0-9]+$/.test(error.message??'')?error.message:'mnn-formal-repair-failed';await fs.writeFile(path.join(run,'private-failure.json'),JSON.stringify({message:error.message,stack:error.stack}));}
finally{
 await kernel?.ctx.fiber.dispose();
 if(report.success){
  const reopened=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(root,'.runtime/home/sessions'));
  try{const handle=await reopened.persistence.open(sid,'read');try{const stored=await handle.read();
   report.native_reopen=hash(stored.events.slice(0,report.events_before))===report.prefix_digest;
   report.checkpoint_closed=stored.events.filter(e=>e.type==='compaction/end').at(-1)?.data.error===undefined;
   report.success=report.success&&report.native_reopen&&report.checkpoint_closed;
  }finally{await handle.close();}}finally{await reopened.ctx.fiber.dispose();}
 }
 report.finished=new Date().toISOString();await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({run,success:report.success,error:report.error}));if(!report.success)process.exitCode=2;
}
