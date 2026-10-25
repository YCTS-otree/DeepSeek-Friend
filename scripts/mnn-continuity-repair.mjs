// Only invoked by the offline, fully verified DSF wrapper. No channel plugins.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {createNativeKernel,registerRemoteProvider} from '../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';
import {mountMnn,exportSession} from '../dsh/mnn.js';import {pressure} from '../src/mnn/guardian.js';import {appendContinuity} from '../src/mnn/continuity.js';
const root=fileURLToPath(new URL('..',import.meta.url)),[sid,data,backup]=process.argv.slice(2).filter(a=>!a.startsWith('--'));
if(!process.argv.includes('--authorized-offline')||!/^[a-f0-9-]{36}$/.test(sid??'')||!data||!backup)throw Error('mnn-offline-gate-required');
const run=path.join(root,'.research/continuity-'+randomUUID());await fs.mkdir(run,{recursive:true});
const report={session:sid,backup,promptSubmissions:0,externalToolExecutors:0};let kernel;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function selfDigest(){const folder=path.join(data,'cognitive/self'),files=await fs.readdir(folder,{recursive:true}),rows=[];for(const n of files.sort()){const f=path.join(folder,n);if((await fs.stat(f)).isFile())rows.push([n,createHash('sha256').update(await fs.readFile(f)).digest('hex')]);}return hash(rows);}
try{
 const selfBefore=await selfDigest();kernel=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(root,'.runtime/home/sessions'));
 const h=await kernel.persistence.open(sid,'read');let original,originalEvents;
 try{const v=await h.read();originalEvents=structuredClone(v.events);original=kernel.sessionModule.Session.create(sid,v.events,h.header,h.inheritedEventCount);}finally{await h.close();}
 // Session.create may synthesize a new end-seed. Compare the actual persisted
 // prefix, not two independently created in-memory seeds with different times.
 const systems=original.deriveMessages().filter(m=>m.role==='system'),tools=original.requestHeader()?.tools;
 if(!tools?.length)throw Error('mnn-original-tools-unavailable');kernel.ctx.tools.schemas=()=>structuredClone(tools);
 await registerRemoteProvider(kernel,root,{contextWindow:1000000,maxTokens:8192,thinking:'enabled'});
 const config=JSON.parse(await fs.readFile(path.join(data,'cognitive/mnn/activation.json'),'utf8')),mnn=mountMnn(kernel.ctx,data,{...config,paused:true});
 kernel.ctx.on('agent/created',({agent})=>{agent.wakeDriver=()=>{};agent.followup=()=>{throw Error('mnn-no-chat-submission');};});
 const {agent}=await kernel.loop.resume(kernel.ctx,{resumeSessionId:sid,agentOptions:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:8192,reasoningEffort:'off'}});
 const pending=agent.inbox.nextTurn.length+agent.inbox.nextStep.length,snapshot=exportSession(agent.session);
 const prepared=await mnn.client.call('continuity_prepare',{export:snapshot,options:{token_budget:8192,max_turns:24}});
 if(prepared.turns<8)throw Error('mnn-continuity-insufficient-evidence');
 // Preflight the exact expanded context, before writing any new Surface event.
 let usage;for await(const p of kernel.ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1,purpose:'compaction',sessionId:sid,tools,
  messages:[...agent.session.deriveMessages(),kernel.llmModule.createUserMessage({source:{kind:'mnn-continuity-context'},content:[{type:'text',text:prepared.context}]})],signal:AbortSignal.timeout(120000)}))if(p.type==='usage')usage=p.usage;
 const input=usage?(usage.inputTokens??0)+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0):null;
 if(!(input>0)||input+12288>600000)throw Error('mnn-continuity-budget-unverified');
 const appended=appendContinuity(agent.session,kernel.llmModule,prepared,snapshot.events);await kernel.ctx.sessions.flush(agent.session);
 const after=exportSession(agent.session);report.eventsBefore=originalEvents.length;report.eventsAfter=after.events.length;
 report.prefixPreserved=isDeepStrictEqual(originalEvents,after.events.slice(0,originalEvents.length));report.systemsPreserved=isDeepStrictEqual(systems,agent.session.deriveMessages().filter(m=>m.role==='system'));
 report.selfUnchanged=selfBefore===await selfDigest();report.inboxUnchanged=pending===agent.inbox.nextTurn.length+agent.inbox.nextStep.length;
 report.turns=prepared.turns;report.messages=prepared.messages;report.contextTokens=prepared.tokens;report.providerInputTokens=input;report.appended=appended.appended;
 report.diagnosticFree=!/CONTEXT_WINDOW_EXCEEDED|recorded_runtime_error|上下文那段|小[“"「]?手术/.test(prepared.context);
 report.dialogueEvidence=JSON.parse(prepared.context).recent_dialogue.flat().map(m=>({native_seq:m.native_seq,role:m.role,textSha256:createHash('sha256').update(m.text).digest('hex')}));
 const sample=await mnn.measurement(agent);report.pressure=pressure(sample);mnn.guardian.observe(sid,sample);
 report.success=report.prefixPreserved&&report.systemsPreserved&&report.selfUnchanged&&report.inboxUnchanged&&report.diagnosticFree&&report.pressure.ratio<.60;
 if(!report.success)throw Error('mnn-continuity-postconditions');
}catch(error){report.success=false;report.error=/^mnn-[a-z0-9-]+$/.test(error.message??'')?error.message:'mnn-continuity-repair-failed';await fs.writeFile(path.join(run,'private-failure.json'),JSON.stringify({message:error.message,stack:error.stack}));}
finally{
 await kernel?.ctx.fiber.dispose();
 if(report.success){const k=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(root,'.runtime/home/sessions'));try{const h=await k.persistence.open(sid,'read');try{const v=await h.read();report.nativeReopen=v.events.length===report.eventsAfter;report.success=report.success&&report.nativeReopen;}finally{await h.close();}}finally{await k.ctx.fiber.dispose();}}
 await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({run,success:report.success,error:report.error}));if(!report.success)process.exitCode=2;
}
