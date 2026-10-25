import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PressureGuardian,SOFT_NOTICE,HARD_NOTICE,committedRecovery,runtimeResumeSource,confirmRestNoop } from '../src/mnn/guardian.js';
import { MnnClient } from '../src/mnn/client.js';
import { RuntimeStore } from '../src/runtime.js';
import * as compaction from '../.runtime/node_modules/@deepseek-ai/dsh-compaction/lib/index.js';
import * as llm from '../.runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { cognitiveEngineClass } from '../vendor/dsf-mnn/adapters/dsh/cognitive-engine.mjs';

export function exportSession(session) {
  const events=Array.from({length:session.seq},(_,seq)=>session.eventAt(seq));
  return {schema:'dsf-mnn-dsh-export/1',session_id:session.id,events,surface:[...session.surface.nodes],
    projected:events.map(event=>({seq:event.seq,message:session.deriveEventMessage(event)}))};
}
export function candidateMessages(agent,plan) {
  const start=plan.shadowed_seqs[0],excluded=new Set(plan.shadowed_seqs),messages=[];
  for(const seq of agent.session.surface.nodes) {
    if(seq===start)messages.push(llm.createUserMessage({source:{kind:'mnn-budget-probe'},content:[{type:'text',text:plan.checkpoint_text}]}));
    if(!excluded.has(seq)){const message=agent.session.deriveEventMessage(agent.session.eventAt(seq));if(message)messages.push(message);}
  }
  return messages;
}
export function mountMnn(ctx,dataDir,config) {
  const client=new MnnClient(path.join(dataDir,'cognitive/mnn'),config);
  const guardian=new PressureGuardian(path.join(dataDir,'cognitive/mnn/pressure.sqlite'),config.guardian);
  const runtime=new RuntimeStore(dataDir),agents=new Map(),samples=new Map(),assemblies=new Map(),lastActivity=new Map(),verified=new Map();
  const associationPending=new Map(),associations=new Map();
  guardian.db.exec('CREATE TABLE IF NOT EXISTS night_schedule(session TEXT PRIMARY KEY,day TEXT NOT NULL)');
  guardian.db.exec('CREATE TABLE IF NOT EXISTS native_usage(n INTEGER PRIMARY KEY,session TEXT,run_id TEXT,body TEXT,created INTEGER)');
  const local=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return {day:parts.year+'-'+parts.month+'-'+parts.day,time:parts.hour+':'+parts.minute};};
  let closed=false;
  const publish=id=>runtime.saveChannelSettings('mnn-pressure:'+id,{state:guardian.get(id).state,updated:Date.now(),error:guardian.get(id).error});
  const Engine=cognitiveEngineClass(compaction,llm);
  async function measurement(agent,assembly=assemblies.get(agent.id),messages=[]) {
    const settings=runtime.settings(),route={provider:settings.provider,model:settings.model,maxTokens:settings.maxTokens,reasoningEffort:settings.reasoningEffort};
    const prepared=await ctx.llm.prepareCall(route,new AbortController().signal);
    if(!(prepared.context?.contextWindow>0))throw Error('mnn-route-unverified');
    const meter=ctx.tokenMeter.measure(agent.session,{config:prepared.config,tools:assembly?.tools??ctx.tools.schemas(agent)});
    // Count actual Chinese/JSON text using official assets, retaining native media pricing/usage as another bound.
    const exact=await client.call('count',{value:{messages:agent.session.deriveMessages(),assembly,messagesToAdmit:messages}});
    const hasMedia=agent.session.deriveMessages().some(m=>m.content.some(b=>['image','file'].includes(b.type)));
    const calibration=verified.get(agent.id);
    const priced=calibration?.generation===agent.session.surface.contentGeneration?{...meter,totalTokens:Math.min(meter.totalTokens,calibration.input+4096),calibration:'provider-preflight-current-surface'}:meter;
    return {meter:priced,exactTokens:exact.tokens,provider:prepared.config.provider,model:prepared.config.model,outputReserve:prepared.config.maxTokens,
      contextWindow:prepared.context.contextWindow,safetyTokens:config.safetyTokens??4096,
      unpricedMedia:hasMedia&&!ctx.llm.imageRequestPricing(prepared.config.provider,prepared.config.model)};
  }
  async function rest(agent,{forced=false}={}) {
    if(agent.status!=='idle'||!guardian.shouldRest(agent.id))return;
    const resumeNeeded=guardian.get(agent.id).state!=='REST_PENDING';
    const previous=guardian.get(agent.id),priorWork=JSON.parse(previous.work??'{}');
    let reconstructionSkipped=false;
    const alreadyCommitted=committedRecovery(previous,exportSession(agent.session).events);
    return agent.runMaintenance(async signal=>{
      const eventsBefore=exportSession(agent.session).events;
      const result=await guardian.rest(agent.id,{safe:true,saveTask:async()=>({session:agent.id,boundary:agent.session.seq,pending:agent.inbox.current(),source:'native-inbox'}),
        dream:async()=>{
          await ctx.sessions.flush(agent.session);
          if(alreadyCommitted)return client.call('prepared',{run_id:priorWork.run_id},signal);
          const s=samples.get(agent.id)??await measurement(agent);
          return client.call('dream',{export:exportSession(agent.session),options:{day:new Date().toISOString().slice(0,10),context_tokens:Math.floor(s.contextWindow*.5),output_reserve:s.outputReserve}},signal);
        },
        reconstruct:async prepared=>{
          if(prepared.compactionNoop){confirmRestNoop(prepared,await measurement(agent),guardian.config.resume);reconstructionSkipped=true;return;}
          const plan=prepared.plan;if(!plan||!prepared.memoryPersisted)throw Error('mnn-plan-not-durable');
          await client.call('validate',{versions:plan.memory_versions},signal);
          if(!alreadyCommitted){
            const oldTokens=plan.shadowed_seqs.reduce((n,q)=>{const m=agent.session.deriveEventMessage(agent.session.eventAt(q));return n+(m?ctx.tokenMeter.estimateMessage(m):0);},0);
            const replacement=llm.createUserMessage({source:{kind:'mnn-budget-probe'},content:[{type:'text',text:plan.checkpoint_text}]});
            if(ctx.tokenMeter.estimateMessage(replacement)>=oldTokens){confirmRestNoop({...prepared,compactionNoop:'checkpoint-not-smaller'},await measurement(agent),guardian.config.resume);reconstructionSkipped=true;return;}
          }
          const messages=alreadyCommitted?agent.session.deriveMessages():candidateMessages(agent,plan),tools=assemblies.get(agent.id)?.tools??ctx.tools.schemas(agent),settings=runtime.settings();
          let usage;const started=Date.now();
          for await(const part of ctx.llm.stream({provider:settings.provider,model:settings.model,reasoningEffort:'off',maxTokens:1,purpose:'compaction',sessionId:agent.id,messages,tools,signal}))if(part.type==='usage')usage=part.usage;
          let input=usage?(usage.inputTokens??0)+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0):null;
          guardian.db.prepare('INSERT INTO native_usage(session,run_id,body,created) VALUES(?,?,?,?)').run(agent.id,prepared.run_id,JSON.stringify({usage:usage??null,input_tokens:input,output_tokens:usage?.outputTokens??null,elapsed_ms:Date.now()-started,kind:'provider-budget-preflight'}),Date.now());
          if(!(input>0)||input+plan.budget.output_reserve>plan.budget.context_tokens)throw Error('mnn-provider-budget-unverified');
          plan.budget.provider_verified_input_tokens=input;plan.validated.provider_envelope_budget=true;plan.status='provider-verified';
          const backend={ctx,plan,readEvents:async()=>exportSession(agent.session).events,persist:s=>ctx.sessions.flush(s),verifyPlan:async()=>{
            const current=exportSession(agent.session).events;if(!isDeepStrictEqual(current.slice(0,eventsBefore.length),eventsBefore))throw Error('mnn-source-changed');
            await client.call('validate',{versions:plan.memory_versions},signal);
          }};
          if(!alreadyCommitted)await Engine.prototype.perform.call(backend,agent,signal);
          if(plan.additional_regions?.length){
            let finalUsage;const finalStarted=Date.now();
            for await(const part of ctx.llm.stream({provider:settings.provider,model:settings.model,reasoningEffort:'off',maxTokens:1,purpose:'compaction',sessionId:agent.id,messages:agent.session.deriveMessages(),tools,signal}))if(part.type==='usage')finalUsage=part.usage;
            const finalInput=finalUsage?(finalUsage.inputTokens??0)+(finalUsage.cacheReadTokens??0)+(finalUsage.cacheWriteTokens??0):null;
            if(!(finalInput>0)||finalInput+plan.budget.output_reserve>plan.budget.context_tokens)throw Error('mnn-provider-budget-unverified');
            input=finalInput;guardian.db.prepare('INSERT INTO native_usage(session,run_id,body,created) VALUES(?,?,?,?)').run(agent.id,prepared.run_id,JSON.stringify({usage:finalUsage,input_tokens:input,output_tokens:finalUsage.outputTokens,elapsed_ms:Date.now()-finalStarted,kind:'provider-private-final-preflight'}),Date.now());
          }
          verified.set(agent.id,{input,generation:agent.session.surface.contentGeneration});
          if(!isDeepStrictEqual(exportSession(agent.session).events.slice(0,eventsBefore.length),eventsBefore))throw Error('mnn-history-changed');
        },measure:()=>measurement(agent)});
      publish(agent.id);
      if(result?.state==='NORMAL')setTimeout(()=>{try{if(closed||agent.status!=='idle')return;
        if(agent.inbox.hasPending)agent.wakeDriver();
        else if(resumeNeeded&&!reconstructionSkipped){const source=exportSession(agent.session).events.filter(e=>e.type==='user/message'&&e.data.source?.rpcId).at(-1)?.data.source;
          agent.followup(llm.createUserMessage({source:runtimeResumeSource(source?.rpcId),content:[{type:'text',text:'短暂休息结束。继续未完成的事，不重复已经完成的对外操作，仍遵守原有授权。'}]}));}
        }catch{guardian.change(agent.id,'RECOVERY_PENDING','mnn-native-resume-failed');publish(agent.id);}
      },0);
      return result;
    });
  }
  // Scope-local service shadows any inherited implementation; never delegates to Basic.
  class MnnCompaction extends compaction.CompactionEngine {
    compactIfNeeded(agent,trigger){if(trigger==='context-overflow'){guardian.change(agent.id,'REST_REQUIRED','provider-overflow');publish(agent.id);}return Promise.resolve(null);}
    compactNow(agent){guardian.change(agent.id,'REST_REQUIRED','operator-rest');return rest(agent,{forced:true});}
    compactRegion(){throw Error('mnn-use-cognitive-rest');}
  }
  new MnnCompaction(ctx);
  ctx.on('agent/created',({agent})=>{agents.set(agent.id,agent);lastActivity.set(agent.id,Date.now());guardian.db.prepare('INSERT OR IGNORE INTO night_schedule VALUES(?,?)').run(agent.id,local().day);});
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
    const agent=context.agent;if(!agent||!agents.has(agent.id))return next();
    assemblies.set(agent.id,assembly);
    try {
      const sample=await measurement(agent,assembly);samples.set(agent.id,sample);const row=guardian.observe(agent.id,sample);publish(agent.id);
      if(row.state!=='NORMAL')assembly.sections.push({name:'mnn:runtime-pressure',text:row.state==='REST_PENDING'?SOFT_NOTICE:HARD_NOTICE,interpolate:false});
    }catch {guardian.change(agent.id,'REST_REQUIRED','measurement-unavailable');publish(agent.id);}
    return next();
  });
  ctx.on('agent/pre-step',async(p,next)=>{
    if(!agents.has(p.agent.id))return next();
    let allow=false;
    try{const sample=await measurement(p.agent,assemblies.get(p.agent.id),p.messages);samples.set(p.agent.id,sample);allow=guardian.observe(p.agent.id,sample).allowRequest;}catch{guardian.change(p.agent.id,'REST_REQUIRED','measurement-unavailable');}
    publish(p.agent.id);
    if(!allow){for(const message of [...p.messages].reverse())p.agent.inbox.prepend('next-turn',message);await ctx.sessions.flush(p.agent.session);return {kind:'reject'};}
    lastActivity.set(p.agent.id,Date.now());return next();
  });
  ctx.on('agent/turn-stopping',async({agent})=>{if(guardian.shouldRest(agent.id))runtime.flag(agent.id,'rest');});
  ctx.on('agent/request-error',async({agent,failure},next)=>{if(/CONTEXT_WINDOW|context.window|overflow/i.test(JSON.stringify(failure))){guardian.change(agent.id,'REST_REQUIRED','provider-overflow');publish(agent.id);}return next();});
  ctx.on('session/event',(session,event)=>{
    if(event.type==='turn/end')lastActivity.set(session.id,Date.now());
    if(event.type==='user/message'&&!['mnn-runtime','compact-checkpoint','friend-continuation','mnn-continuity-context'].includes(event.data.source?.kind))associationPending.set(session.id,session);
  });
  const tick=async()=>{
    if(config.paused)return;
    guardian.recover();
    for(const agent of agents.values())if(agent.status==='idle') {
      const clock=local(),night=guardian.db.prepare('SELECT day FROM night_schedule WHERE session=?').get(agent.id);
      if(clock.time>=(config.dreamingTime??'03:00')&&night&&night.day<clock.day&&guardian.get(agent.id).state==='NORMAL'){
        guardian.change(agent.id,'REST_PENDING','scheduled-dreaming');guardian.db.prepare('UPDATE night_schedule SET day=? WHERE session=?').run(clock.day,agent.id);publish(agent.id);
      }
      if(guardian.shouldRest(agent.id)){await rest(agent);continue;}
      if(guardian.get(agent.id).state!=='NORMAL')continue;
      if(associationPending.has(agent.id)){
        await ctx.sessions.flush(agent.session);const result=await client.call('associate_native',{export:exportSession(agent.session)});
        associations.set(agent.id,result);associationPending.delete(agent.id);
      }
      const idle=Date.now()-(lastActivity.get(agent.id)??Date.now());
      if(idle>=(config.idleMinutes??15)*60000){
        const s=samples.get(agent.id)??await measurement(agent);
        await client.call('dream',{export:exportSession(agent.session),options:{day:new Date().toISOString().slice(0,10),context_tokens:Math.floor(s.contextWindow*.5),output_reserve:s.outputReserve,reconstruct:false}});
        lastActivity.set(agent.id,Date.now());
      }
    }
  };
  let ticking=false;const timer=setInterval(()=>{if(!ticking){ticking=true;tick().catch(()=>{}).finally(()=>ticking=false);}},1000);timer.unref?.();
  ctx.effect(()=>()=>{closed=true;clearInterval(timer);client.close();guardian.close();runtime.close();});
  return {client,guardian,rest,measurement,associations};
}
