import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import{createNativeKernel}from'../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';import{cognitiveEngineClass}from'../vendor/dsf-mnn/adapters/dsh/cognitive-engine.mjs';import{MnnClient}from'../src/mnn/client.js';import{exportSession}from'../dsh/mnn.js';
test('native private reconstruction hides old diagnostic surface and preserves raw prefix, identity and session',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsf-private-native-')),kernel=await createNativeKernel(path.resolve('.runtime/node_modules'),path.join(dir,'sessions'));
 const client=new MnnClient(path.join(dir,'memory'),{tokenizer:path.resolve('.runtime/mnn-tokenizer'),standalone:true});
 try{
  const s=kernel.sessionModule.Session.create('privacy-synthetic'),llm=kernel.llmModule;
  s.append('turn/start',{turn:1});s.append('step/start',{turn:1,step:1});s.append('system/message',{turn:1,step:1,message:llm.createSystemMessage('original Core and Self')},{surfaceOp:'append'});
  for(let i=0;i<8;i++){
   if(i===3||i===6)s.append('system/message',{turn:1,step:1,message:llm.createSystemMessage('original Core and Self')},{surfaceOp:'append'});
   s.append('user/message',llm.createUserMessage({source:{kind:'synthetic'},content:[{type:'text',text:('CONTEXT_WINDOW_EXCEEDED 上下文修复 '+i+' ').repeat(300)}]}),{surfaceOp:'append'});
  }
  s.append('step/end',{turn:1,step:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  const before=exportSession(s),prepared=await client.call('privacy_prepare',{export:before,options:{context_tokens:200000,output_reserve:256}});
  const Engine=cognitiveEngineClass(await kernel.load('dsh-compaction'),llm);const engine=new Engine(kernel.ctx,{plan:prepared.plan,readEvents:async()=>exportSession(s).events,persist:async()=>{},verifyPlan:async()=>{}});
  await engine.compactNow({session:s,runMaintenance:fn=>fn(new AbortController().signal)},new AbortController().signal);
  assert.deepEqual(exportSession(s).events.slice(0,before.events.length),before.events);assert.equal(s.id,'privacy-synthetic');
  const visible=JSON.stringify(s.deriveMessages());assert.ok(!visible.includes('CONTEXT_WINDOW_EXCEEDED'));assert.ok(!visible.includes('上下文修复'));assert.ok(visible.includes('original Core and Self'));
  assert.equal(s.deriveMessages().filter(m=>m.role==='system').length,3);
 }finally{client.close();await kernel.ctx.fiber.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
