import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNativeKernel} from '../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';
import {mountMnn,exportSession} from '../dsh/mnn.js';
import {MnnClient} from '../src/mnn/client.js';

test('native Inbox accepts concurrent input during MNN maintenance without losing source events or duplicating wake',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsf-native-race-'));
 const kernel=await createNativeKernel(path.resolve('.runtime/node_modules'),path.join(dir,'sessions'),{system:'synthetic identity'});
 const original=MnnClient.prototype.call;let release,entered;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);let probes=0,wakes=0;
 let mnn;
 try{
  kernel.ctx.llm.prepareCall=async(config)=>({config:{...config,maxTokens:256},context:{contextWindow:65536}});
  kernel.ctx.llm.stream=async function*(){probes++;yield{type:'usage',usage:{inputTokens:100,outputTokens:1,totalTokens:101}};};
  MnnClient.prototype.call=async function(action,args){
   if(action==='count')return{tokens:100};if(action==='validate')return{valid:true};
   if(action==='dream'){
    entered();await waiting;const surface=args.export.surface;
    return{run_id:'mock-race',memoryPersisted:true,plan:{session_id:args.export.session_id,original_surface:surface,shadowed_seqs:[surface[1]],checkpoint_text:'{"run_id":"mock-race","carryover":"saved"}',memory_versions:{},budget:{context_tokens:32768,output_reserve:256},validated:{}}};
   }
   return{state:'noop',proposals:[]};
  };
  mnn=mountMnn(kernel.ctx,path.join(dir,'data'),{enabled:true,paused:true,tokenizer:'mock'});
  const agent=await kernel.loop.create('native-inbox-race',{provider:'deepseek-official',model:'deepseek-flash'});
  agent.wakeDriver=()=>{wakes++;};
  const s=agent.session,{createSystemMessage,createUserMessage}=kernel.llmModule;
  s.append('turn/start',{turn:1});s.append('step/start',{turn:1,step:1});
  s.append('system/message',{turn:1,step:1,message:createSystemMessage('synthetic identity')},{surfaceOp:'append'});
  s.append('user/message',createUserMessage({source:{kind:'synthetic'},content:[{type:'text',text:'historical evidence '.repeat(2000)}]}),{surfaceOp:'append'});
  s.append('system/message',{turn:1,step:1,message:createSystemMessage('synthetic identity')},{surfaceOp:'append'});
  s.append('step/end',{turn:1,step:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  const prefix=structuredClone(exportSession(s).events);
  mnn.guardian.change(agent.id,'REST_REQUIRED','synthetic-pressure');
  const maintenance=mnn.rest(agent);await started;
  const queued=createUserMessage({source:{kind:'synthetic',rpcId:'original-new-request'},content:[{type:'text',text:'concurrent input'}]});
  agent.inbox.append('next-turn',queued);await kernel.ctx.sessions.flush(s);
  assert.equal(mnn.guardian.get(agent.id).state,'DREAMING');assert.equal(agent.inbox.nextTurn[0].id,queued.id);
  release();const result=await maintenance;await new Promise(r=>setTimeout(r,20));
  assert.equal(result.state,'NORMAL');assert.equal(agent.inbox.nextTurn.length,1);assert.equal(agent.inbox.nextTurn[0].source.rpcId,'original-new-request');
  assert.equal(wakes,1);assert.equal(probes,1);assert.deepEqual(exportSession(s).events.slice(0,prefix.length),prefix);
  assert.equal(exportSession(s).events.filter(e=>e.type==='compaction/summary').length,1);
 }finally{await kernel.ctx.fiber.dispose();MnnClient.prototype.call=original;await fs.rm(dir,{recursive:true,force:true});}
});
