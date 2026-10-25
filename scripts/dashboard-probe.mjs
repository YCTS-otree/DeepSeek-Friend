// Operator-only numeric telemetry. Never exports credentials or model content.
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {apiKeyEnvironment} from './runtime-options.js';
import {loadCredentials} from '../src/security.js';
import {loadConfig} from '../src/config.js';
import {DshClient} from '../src/dsh.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export function projectionMetrics(p){
 if(!p?.values)throw Error('dashboard-projection-unavailable');
 const pick=(v,names)=>Object.fromEntries(names.map(n=>[n,count(v?.[n])]));
 return {asOfSeq:count(p.asOfSeq),context:pick(p.values.contextPressure,['pressureTokens','projectedTokens','contextWindow']),
  breakdown:pick(p.values.contextBreakdown,['systemTokens','toolsTokens','messageTokens']),
  tokens:pick(p.values.tokenUsage,['uncachedInputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']),
  stats:pick(p.values.sessionStats,['turns','steps','llmMs','toolMs','ttftMs','ttftSteps','decodeMs','decodeTokens'])};
}
export async function queryBalance({fetchImpl=fetch,keyProvider=()=>apiKeyEnvironment(root).env.DEEPSEEK_API_KEY}={}){
 const key=keyProvider();if(!key)return {status:'unavailable',error:'balance-key-unavailable'};
 try{
  const response=await fetchImpl('https://api.deepseek.com/user/balance',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(7000)});
  if(!response.ok)return {status:'error',error:'balance-http-'+response.status};
  const text=await response.text();if(text.length>16384)throw Error();const value=JSON.parse(text);
  if(typeof value.is_available!=='boolean'||!Array.isArray(value.balance_infos)||!value.balance_infos.length||value.balance_infos.length>8)throw Error();
  const rows=value.balance_infos.map(r=>{
   if(!['CNY','USD'].includes(r.currency))throw Error();
   const clean={currency:r.currency};for(const k of ['total_balance','granted_balance','topped_up_balance']){if(typeof r[k]!=='string'||!/^\-?\d{1,30}(?:\.\d{1,20})?$/.test(r[k]))throw Error();clean[k]=r[k];}return clean;
  });return {status:'ready',available:value.is_available,balances:rows,checkedAt:Date.now()};
 }catch{return {status:'error',error:'balance-query-failed'};}
}
async function main(){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw Error('dashboard-input-limit');}
 const args=JSON.parse(input),result={};
 await Promise.all([
  (async()=>{if(!args.session)return;try{const c=loadConfig(),saved=loadCredentials(c.dataDir,'dsh-connection.json'),client=new DshClient({...c.dsh,cookie:saved?.cookie,timeoutMs:4000});result.native={status:'ready',checkedAt:Date.now(),...projectionMetrics(await client.rpc('session/projections',{sessionId:args.session}))};}catch{result.native={status:'error',error:'dsh-metrics-unavailable',checkedAt:Date.now()};}})(),
  (async()=>{if(args.balance)result.balance=await queryBalance();})()
 ]);process.stdout.write(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stdout.write('{"error":"dashboard-probe-failed"}');process.exitCode=1;});
