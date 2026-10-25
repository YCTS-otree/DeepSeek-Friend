import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import{DatabaseSync}from'node:sqlite';
import{createNativeKernel}from'../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';import{mountMnn}from'../dsh/mnn.js';import{MnnClient}from'../src/mnn/client.js';
test('idle/background scan cannot import an archived, unknown or wrong-generation agent even if it is loaded',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsf-source-isolation-')),registry=path.join(root,'bridge.sqlite'),db=new DatabaseSync(registry);
 db.exec("CREATE TABLE meta(key PRIMARY KEY,value);INSERT INTO meta VALUES('mnn-generation','epoch-a');CREATE TABLE chat_sessions(session PRIMARY KEY,kind,archived);INSERT INTO chat_sessions VALUES('active','conversation',0),('archive','conversation',1),('test','test',0)");
 const k=await createNativeKernel(path.resolve('.runtime/node_modules'),path.join(root,'sessions')),original=MnnClient.prototype.call,calls=[];
 MnnClient.prototype.call=async function(action,args){if(action==='count')return{tokens:100};calls.push([action,args.export?.session_id]);return{memoryPersisted:true,proposals:[]};};
 k.ctx.llm.prepareCall=async config=>({config:{...config,maxTokens:8192},context:{contextWindow:1000000}});
 try{
  const mnn=mountMnn(k.ctx,root,{enabled:true,generation:'epoch-a',tokenizer:'mock',idleMinutes:0});
  for(const id of ['active','archive','unknown','test']){const a=await k.loop.create(id,{provider:'deepseek-official',model:'deepseek-flash'});a.wakeDriver=()=>{};}
  await mnn.tick();assert.deepEqual(calls,[['dream','active']]);calls.length=0;
  db.exec("UPDATE chat_sessions SET archived=1 WHERE session='active'");await mnn.tick();assert.equal(calls.length,0);
  db.exec("UPDATE chat_sessions SET archived=0 WHERE session='active';UPDATE meta SET value='epoch-b' WHERE key='mnn-generation'");await mnn.tick();assert.equal(calls.length,0);
 }finally{await k.ctx.fiber.dispose();MnnClient.prototype.call=original;db.close();await fs.rm(root,{recursive:true,force:true});}
});

test('real Python workers reject archived sources across restart and cannot reuse an earlier generation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsf-worker-isolation-')),registry=path.join(root,'bridge.sqlite'),directory=path.join(root,'memory'),db=new DatabaseSync(registry);
 db.exec("CREATE TABLE meta(key PRIMARY KEY,value);INSERT INTO meta VALUES('mnn-generation','epoch-a');CREATE TABLE chat_sessions(session PRIMARY KEY,kind,archived);INSERT INTO chat_sessions VALUES('active','conversation',0),('archive','conversation',1)");
 const config={registryFile:registry,generation:'epoch-a',tokenizer:'unused-for-capture'};
 const payload=id=>({schema:'dsf-mnn-dsh-export/1',session_id:id,events:[{seq:0,time:1792400000000,type:'user/message',data:{role:'user',content:[{type:'text',text:'synthetic source fixture'}]}}],projected:[{seq:0,message:{role:'user',content:[{type:'text',text:'synthetic source fixture'}]}}],surface:[0]});
 let client=new MnnClient(directory,config);
 try{
  await assert.rejects(client.call('capture',{export:payload('archive')}),/source-inactive/);
  await client.call('capture',{export:payload('active')});client.close();client=new MnnClient(directory,config);
  await assert.rejects(client.call('capture',{export:payload('archive')}),/source-inactive/);
  db.exec("UPDATE chat_sessions SET archived=1 WHERE session='active'");
  await assert.rejects(client.call('capture',{export:payload('active')}),/source-inactive/);
  client.close();client=new MnnClient(directory,{...config,generation:'epoch-b'});
  db.exec("UPDATE meta SET value='epoch-b'");
  await assert.rejects(client.call('capture',{export:payload('active')}),/mnn-worker-/);
  const memory=new DatabaseSync(path.join(directory,'memory.sqlite'),{readOnly:true});
  try{assert.deepEqual(memory.prepare('SELECT DISTINCT session FROM native_sources').all().map(r=>r.session),['active']);assert.equal(memory.prepare('SELECT count(*) AS n FROM events').get().n,1);}
  finally{memory.close();}
 }finally{client.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
