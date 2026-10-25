import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createNativeKernel}from'../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';import{MnnClient}from'../src/mnn/client.js';import{exportSession}from'../dsh/mnn.js';import{appendContinuity}from'../src/mnn/continuity.js';
test('native continuity restoration preserves raw events, SYS, id and Inbox semantics without an Agent turn',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsf-continuity-')),k=await createNativeKernel(path.resolve('.runtime/node_modules'),path.join(dir,'sessions')),client=new MnnClient(path.join(dir,'memory'),{tokenizer:path.resolve('.runtime/mnn-tokenizer'),standalone:true});
 try{
  const s=k.sessionModule.Session.create('same-session'),llm=k.llmModule;
  s.append('system/message',{turn:1,step:1,message:llm.createSystemMessage('Original Core and Self')},{surfaceOp:'append'});
  for(let turn=1;turn<=8;turn++){
   s.append('user/message',llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'昨天聊的话题 '+turn}]}),{surfaceOp:'append'});
   s.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'嗯，明天继续 '+turn}]}},{surfaceOp:'append'});
  }
  const snapshot=exportSession(s).events,prepared=await client.call('continuity_prepare',{export:exportSession(s)});
  assert.equal(prepared.turns,8);const result=appendContinuity(s,llm,prepared,snapshot);
  assert.equal(result.appended,true);assert.equal(s.seq,snapshot.length+1);assert.deepEqual(exportSession(s).events.slice(0,snapshot.length),snapshot);
  assert.equal(s.eventAt(result.seq).data.source.kind,'mnn-continuity-context');assert.equal(s.id,'same-session');
  assert.ok(s.deriveMessages().at(-1).content[0].text.includes('嗯，明天继续'));
  assert.equal(appendContinuity(s,llm,prepared,snapshot).appended,false);
  assert.throws(()=>appendContinuity(s,llm,{...prepared,digest:'bad'},snapshot),/continuity-invalid/);
 }finally{client.close();await k.ctx.fiber.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
