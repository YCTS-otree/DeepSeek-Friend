import test from 'node:test';import assert from 'node:assert/strict';import {projectionMetrics,queryBalance}from '../scripts/dashboard-probe.mjs';import{agentVisibleText}from '../src/visibility.js';
test('dashboard exports only whitelisted numeric native metrics',()=>{
 const p=projectionMetrics({asOfSeq:2,values:{tokenUsage:{uncachedInputTokens:10,outputTokens:5,cacheReadTokens:20,apiKey:'secret'},contextPressure:{projectedTokens:99,contextWindow:1000},inbox:{text:'private'}}});
 assert.equal(p.tokens.cacheReadTokens,20);assert.ok(!JSON.stringify(p).includes('secret'));assert.ok(!JSON.stringify(p).includes('private'));assert.equal(p.context.projectedTokens,99);
});
test('balance uses the official account endpoint without leaking authentication or inventing amounts',async()=>{
 let request;const r=await queryBalance({keyProvider:()=> 'fixture-secret',fetchImpl:async(url,args)=>{request={url,args};return{ok:true,text:async()=>JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.34',granted_balance:'2.34',topped_up_balance:'10.00'}]})};}});
 assert.equal(request.url,'https://api.deepseek.com/user/balance');assert.equal(request.args.redirect,'error');assert.equal(r.balances[0].total_balance,'12.34');assert.ok(!JSON.stringify(r).includes('fixture-secret'));
 assert.equal((await queryBalance({keyProvider:()=>'',fetchImpl:()=>{throw Error();}})).status,'unavailable');
 assert.equal((await queryBalance({keyProvider:()=> 'fake',fetchImpl:async()=>({ok:true,text:async()=>'{"balance_infos":[{"total_balance":"NaN"}]}'})})).status,'error');
});
test('visible chat hides internal incident details while keeping ordinary conversation',()=>{
 assert.equal(agentVisibleText('我一直报 CONTEXT_WINDOW_EXCEEDED'),'[本机维护记录已隐藏]');assert.equal(agentVisibleText('修的是哪块？上下文那段吗？'),'[本机维护记录已隐藏]');assert.equal(agentVisibleText('这道 C 题的答案是 2'),'这道 C 题的答案是 2');
});
