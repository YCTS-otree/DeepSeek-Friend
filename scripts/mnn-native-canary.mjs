// Opt-in real provider validation; never opens production sessions or channels.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createNativeKernel,registerRemoteProvider } from '../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';
import { mountMnn,exportSession } from '../dsh/mnn.js';
import { pressure } from '../src/mnn/guardian.js';
import { RuntimeStore } from '../src/runtime.js';

if(!process.argv.includes('--live'))throw Error('mnn-live-provider-opt-in-required');
const root=fileURLToPath(new URL('..',import.meta.url)),run=path.join(root,'.research/mnn-v120/native-'+randomUUID());
await fs.mkdir(run,{recursive:true});const data=path.join(run,'data');
const report={schema:'dsf-mnn-native-canary/1',run,production_written:false,basic_loaded:false,rounds:[],started:new Date().toISOString()};
const sourceFiles=['dsh/mnn.js','src/mnn/client.js','src/mnn/guardian.js','vendor/dsf-mnn/src/dsf_mnn/production.py','vendor/dsf-mnn/src/dsf_mnn/acr.py','vendor/dsf-mnn/src/dsf_mnn/semantic.py','vendor/dsf-mnn/adapters/dsh/native-kernel.mjs'];
const fingerprint=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])));
report.source_files=await fingerprint();
let kernel,mnn;
const save=async(name,value)=>fs.writeFile(path.join(run,name),JSON.stringify(value,null,2));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  kernel=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(run,'sessions'),{system:'这是隔离研发会话。你是小鲸鱼，OTREE 是开发者。保持 project port=3099 的精确记录。只简短回应，不执行外部操作。',complete:false});
  const window=Number(process.argv.find(x=>x.startsWith('--window='))?.split('=')[1]??65536);
  await registerRemoteProvider(kernel,root,{contextWindow:window,maxTokens:256});
  const prepared=await kernel.ctx.llm.prepareCall({provider:'deepseek-official',model:'deepseek-flash',maxTokens:256,reasoningEffort:'off'});
  report.context_window=prepared.context.contextWindow;if(report.context_window>131072)throw Error('mnn-test-route-window-too-large');
  const runtime=new RuntimeStore(data);runtime.configure({continuous:false,reasoningEffort:'off',maxTokens:256});runtime.close();
  mnn=mountMnn(kernel.ctx,data,{enabled:true,tokenizer:path.join(root,'.research/mnn-v120/tokenizer'),idleMinutes:9999},{standalone:true});
  const {defineTool}=await kernel.load('dsh-tools');
  kernel.ctx.tools.register(defineTool({name:'memory_recall',description:'从同一 MNN 网络读取有来源的事实。',parameters:{query:{type:'string',required:true}},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:a=>mnn.client.call('recall',{query:a.query})}));
  const agent=await kernel.loop.create(randomUUID(),{provider:'deepseek-official',model:'deepseek-flash',maxTokens:256,reasoningEffort:'off'});
  const ask=async text=>{agent.followup(kernel.llmModule.createUserMessage({source:{kind:'synthetic-authorized-test'},content:[{type:'text',text}]}));await agent.whenIdle();await kernel.ctx.sessions.flush(agent.session);};
  await ask('记录项目 port=3099，目标是验证三轮小憩后仍能继续原来的任务。只回复已收到。');
  for(let round=0;round<3;round++){
    let sample=await mnn.measurement(agent),ratio=pressure(sample).ratio,count=0;
    const target=round===1?.96:.86;
    while(ratio<target&&count++<80){
      agent.session.append('user/message',kernel.llmModule.createUserMessage({source:{kind:'synthetic-log'},content:[{type:'text',text:('常规临时日志：已经检查输入，项目精确参数保持不变。这部分无需逐字进入长期记忆。').repeat(window<=16384?20:100)}]}),{surfaceOp:'append'});
      sample=await mnn.measurement(agent);ratio=pressure(sample).ratio;
    }
    if(ratio<target)throw Error('mnn-pressure-fixture-did-not-reach-threshold');
    const before=exportSession(agent.session);await save('round-'+round+'-before.json',before);
    console.log(JSON.stringify({stage:'pressure-grown',round,ratio}));
    // Soft threshold is discovered by the real assembly/pre-step hooks. At 95%
    // the guard must requeue this exact native input before invoking Dreaming.
    agent.followup(kernel.llmModule.createUserMessage({source:{kind:'synthetic-authorized-test'},content:[{type:'text',text:'先调用 memory_recall 查 project port=3099，再简短回复确认，随后整理记忆。项目 port=3099 保持不变。'}]}));
    await agent.whenIdle();
    const deadline=Date.now()+1800000;let sawRest=false;
    while(Date.now()<deadline){
      const row=mnn.guardian.get(agent.id);if(row.state!=='NORMAL')sawRest=true;
      if(row.state==='REST_FAILED')throw Error(row.error??'mnn-native-rest-failed');
      if(sawRest&&row.state==='NORMAL')break;await pause(500);
    }
    if(!sawRest||mnn.guardian.get(agent.id).state!=='NORMAL')throw Error('mnn-native-rest-timeout');
    await pause(1000);await agent.whenIdle();await kernel.ctx.sessions.flush(agent.session);
    const after=exportSession(agent.session);await save('round-'+round+'-after.json',after);
    const measured=pressure(await mnn.measurement(agent));const recall=await mnn.client.call('recall',{query:'project port=3099'});await save('round-'+round+'-recall.json',recall);
    const row={round,session_id:agent.id,original_prefix_equal:isDeepStrictEqual(after.events.slice(0,before.events.length),before.events),before_ratio:ratio,after_ratio:measured.ratio,recall_sources:recall.evidence_refs,
      compactions:after.events.filter(e=>e.type==='compaction/summary').length,carryover:after.events.filter(e=>e.type==='compaction/summary').at(-1)?.data.summary?.[0]?.text?.includes('current_goals')};
    report.rounds.push(row);await save('report.json',report);console.log(JSON.stringify({stage:'round-completed',...row}));
    if(!row.original_prefix_equal||measured.ratio>.60||!recall.evidence_refs.length)throw Error('mnn-native-quality-gate');
  }
  report.source_unchanged=isDeepStrictEqual(report.source_files,await fingerprint());
  report.success=report.source_unchanged;
}catch(error){report.success=false;report.error=/^mnn-[a-z0-9-]+$/.test(error.message??'')?error.message:'mnn-native-test-failed';await save('private-failure.txt',{name:error.name,message:error.message,stack:error.stack});}
finally{await kernel?.ctx.fiber?.dispose?.();report.finished=new Date().toISOString();await save('report.json',report);console.log(JSON.stringify({run,success:report.success,rounds:report.rounds.length,error:report.error}));if(!report.success)process.exitCode=2;}
