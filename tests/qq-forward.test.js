import test from 'node:test';import assert from 'node:assert/strict';import {expandForward} from '../src/qq-forward.js';
test('merged records unwrap native nodes, preserve text/image order and skip video without authenticating quoted authors',async()=>{
 const calls=[];const data=await expandForward([{type:'forward',data:{id:'fixture'}}],async(action,args)=>{calls.push({action,args});return{messages:[{type:'node',data:{nickname:'OTREE',user_id:3626097226,message:[{type:'text',data:{text:'引用文字'}},{type:'image',data:{url:'https://gchat.qpic.cn/fixture.png'}},{type:'video',data:{file:'must-not-download'}}]}}]};});
 assert.equal(calls[0].action,'get_forward_msg');assert.match(data.text,/引用文字/);assert.match(data.text,/未认证/);assert.match(data.text,/视频已跳过/);assert.equal(data.images.length,1);assert.ok(!data.text.includes('must-not-download'));
});
test('nested and cyclic references have bounded work, text and images',async()=>{
 let calls=0;const record=await expandForward([{type:'forward',data:{id:'repeat'}}],async()=>{calls++;return{messages:[{sender:{nickname:'x'},content:[{type:'forward',data:{id:'repeat'}},{type:'text',data:{text:'x'.repeat(4000)}},{type:'image',data:{url:'https://gchat.qpic.cn/x'}}]}]};},{maxChars:400,maxImages:1});
 assert.equal(calls,1);assert.ok(record.text.length<600);assert.match(record.text,/上限/);
 await assert.rejects(expandForward([{type:'forward',data:{id:'bad id'}}],async()=>{}),{code:'qq-forward-id'});
 await assert.rejects(expandForward([{type:'forward',data:{id:'valid'}}],async()=>({messages:null})),{code:'qq-forward-shape'});
});

test('inline gateway expansion remains readable after restart without another lookup',async()=>{
 const result=await expandForward([{type:'forward',data:{id:'123',content:[{sender:{nickname:'引用作者'},message:[{type:'text',data:{text:'PERSISTED_FORWARD'}}]}]}}],async()=>{throw Error('must-not-look-up');});assert.match(result.text,/PERSISTED_FORWARD/);
});
