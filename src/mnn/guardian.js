import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SOFT_NOTICE = '你需要休息一小会了，下次回复后会进行小憩。';
export const HARD_NOTICE = '你必须休息了。';
export function confirmRestNoop(prepared,sample,resume=.60){
  if(!prepared?.memoryPersisted||!['acr-no-safe-rolling-range','acr-no-useful-range','checkpoint-not-smaller'].includes(prepared.compactionNoop))throw Error('mnn-plan-not-durable');
  const p=pressure(sample);
  if(p.reason!=='measured'||p.ratio>resume)throw Error('mnn-insufficient-headroom-or-fixed-context');
  return p;
}
export function runtimeResumeSource(rpcId){return {kind:'mnn-runtime',...(typeof rpcId==='string'&&rpcId?{resumesRpcId:rpcId}:{})};}
export function committedRecovery(row,events) {
  if(!['RECOVERY_PENDING','DREAMING','RECONSTRUCTING'].includes(row.state))return false;
  const work=JSON.parse(row.work??'{}');if(!work.run_id)return false;
  const summary=events.find(e=>e.type==='compaction/summary'&&e.seq>=work.boundary&&(e.data.model==='cognitive-dreaming-acr/1:'+work.run_id||e.data.summary?.some(b=>b.text?.includes('"run_id":"'+work.run_id+'"'))));
  return Boolean(summary&&events.some(e=>e.type==='compaction/end'&&e.data.compactionId===summary.data.compactionId&&!e.data.error));
}
export function guardianConfig(input = {}) {
  const c = { soft: .85, hard: .95, resume: .60, maxAttempts: 3, retryMs: 60000, leaseMs: 600000, ...input };
  if (![c.soft,c.hard,c.resume].every(Number.isFinite) || !(0<c.resume&&c.resume<c.soft&&c.soft<c.hard&&c.hard<1)
      || !Number.isSafeInteger(c.maxAttempts)||c.maxAttempts<1||c.maxAttempts>5||c.retryMs<1000||c.leaseMs<10000) throw Error('mnn-guardian-config');
  return c;
}
// Native meter anchors include route-priced media and provider usage. Exact pricing
// is supplied by the installed MNN tokenizer, never a characters/4 replacement.
export function pressure(sample) {
  const { meter, exactTokens, contextWindow, outputReserve=8192, nextInputTokens=0, safetyTokens=2048 }=sample;
  if (!(contextWindow>outputReserve&&outputReserve>0) || !sample.provider || !sample.model) throw Error('mnn-route-unverified');
  const exact=Number.isFinite(exactTokens)&&exactTokens>=0;
  const anchored=meter?.baseline?.kind==='usage'&&Number.isFinite(meter.totalTokens);
  if ((!exact&&!anchored)||sample.unpricedMedia||!(nextInputTokens>=0)) return {ratio:1,reason:'measurement-unavailable',predicted:contextWindow,contextWindow};
  const occupied=Math.max(exact?exactTokens:0,meter?.totalTokens??0,sample.providerInputTokens??0);
  const predicted=occupied+Math.ceil(nextInputTokens)+outputReserve+safetyTokens;
  return {ratio:predicted/contextWindow,predicted,occupied,contextWindow,outputReserve,provider:sample.provider,model:sample.model,
    meterBaseline:meter?.baseline?.kind,exact,reason:'measured'};
}
export class PressureGuardian {
  constructor(file, config={}, {now=Date.now}={}) {
    this.config=guardianConfig(config);this.now=now;this.owner=randomUUID();this.running=new Map();
    fs.mkdirSync(path.dirname(file),{recursive:true});this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pressure(session TEXT PRIMARY KEY,state TEXT NOT NULL,measurement TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,owner TEXT,lease INTEGER NOT NULL DEFAULT 0,
        work TEXT,error TEXT,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transitions(n INTEGER PRIMARY KEY,session TEXT,state TEXT,reason TEXT,created INTEGER);`);
  }
  get(id) {return this.db.prepare('SELECT * FROM pressure WHERE session=?').get(id)??{session:id,state:'NORMAL',attempts:0,retry_at:0,lease:0};}
  change(id,state,reason,fields={}) {
    this.db.prepare("INSERT OR IGNORE INTO pressure(session,state,updated) VALUES(?,'NORMAL',?)").run(id,this.now());
    this.db.prepare('UPDATE pressure SET state=?,updated=?,error=? WHERE session=?').run(state,this.now(),reason,id);
    for(const [key,value] of Object.entries(fields)) {
      if(!['measurement','attempts','retry_at','owner','lease','work'].includes(key))throw Error('mnn-guardian-field');
      this.db.prepare(`UPDATE pressure SET ${key}=? WHERE session=?`).run(value,id);
    }
    this.db.prepare('INSERT INTO transitions(session,state,reason,created) VALUES(?,?,?,?)').run(id,state,reason,this.now());return this.get(id);
  }
  observe(id,sample) {
    const p=pressure(sample),row=this.get(id);
    this.db.prepare("INSERT OR IGNORE INTO pressure(session,state,updated) VALUES(?,'NORMAL',?)").run(id,this.now());
    this.db.prepare('UPDATE pressure SET measurement=?,updated=? WHERE session=?').run(JSON.stringify(p),this.now(),id);
    let notice=null;
    if(p.ratio>=this.config.hard&&['NORMAL','REST_PENDING'].includes(row.state)) {
      this.change(id,'REST_REQUIRED',p.reason);notice=HARD_NOTICE;
    } else if(p.ratio>=this.config.soft&&row.state==='NORMAL') {
      this.change(id,'REST_PENDING','soft-threshold');notice=SOFT_NOTICE;
    }
    return {...this.get(id),pressure:p,notice,allowRequest:['NORMAL','REST_PENDING'].includes(this.get(id).state)&&p.ratio<this.config.hard};
  }
  shouldRest(id) {return ['REST_PENDING','REST_REQUIRED','RECOVERY_PENDING'].includes(this.get(id).state);}
  blocked(id) {return !['NORMAL','REST_PENDING'].includes(this.get(id).state);}
  retry(id) {const row=this.get(id);if(!['REST_FAILED','RECOVERY_PENDING'].includes(row.state))throw Error('mnn-retry-state');return this.change(id,'RECOVERY_PENDING','operator-retry',{attempts:0,retry_at:0});}
  recover() {
    for(const row of this.db.prepare("SELECT * FROM pressure WHERE state IN ('DREAMING','RECONSTRUCTING') AND lease<=?").all(this.now()))
      this.change(row.session,'RECOVERY_PENDING','interrupted',{owner:null,lease:0});
  }
  async rest(id,{safe,dream,reconstruct,measure,saveTask=async()=>({})}) {
    if(this.running.has(id))return this.running.get(id);
    const task=this.perform(id,{safe,dream,reconstruct,measure,saveTask});this.running.set(id,task);
    try{return await task;}finally{this.running.delete(id);}
  }
  async perform(id,{safe,dream,reconstruct,measure,saveTask}) {
    this.recover();let row=this.get(id);
    if(!safe||!this.shouldRest(id)||row.attempts>=this.config.maxAttempts||row.retry_at>this.now())return {state:row.state,deferred:true};
    const acquired=this.db.prepare("UPDATE pressure SET state='DREAMING',owner=?,lease=?,attempts=attempts+1,updated=? WHERE session=? AND state IN ('REST_PENDING','REST_REQUIRED','RECOVERY_PENDING') AND lease<=?")
      .run(this.owner,this.now()+this.config.leaseMs,this.now(),id,this.now()).changes;
    if(!acquired)return {state:this.get(id).state,deferred:true};
    const renew=setInterval(()=>this.db.prepare('UPDATE pressure SET lease=? WHERE session=? AND owner=?').run(this.now()+this.config.leaseMs,id,this.owner),Math.floor(this.config.leaseMs/3));renew.unref?.();
    try {
      const saved=await saveTask();this.db.prepare('UPDATE pressure SET work=? WHERE session=?').run(JSON.stringify(saved),id);
      const prepared=await dream(saved);
      if(!prepared?.memoryPersisted)throw Error('mnn-memory-not-durable');
      this.db.prepare('UPDATE pressure SET work=? WHERE session=?').run(JSON.stringify({...saved,run_id:prepared.run_id}),id);
      this.change(id,'RECONSTRUCTING','memory-durable');
      await reconstruct(prepared);const p=pressure(await measure());
      if(p.ratio>this.config.resume)throw Error('mnn-insufficient-headroom-or-fixed-context');
      this.change(id,'NORMAL','rest-completed',{measurement:JSON.stringify(p),attempts:0,retry_at:0,owner:null,lease:0});
      return {state:'NORMAL',pressure:p};
    } catch(error) {
      row=this.get(id);const code=/^mnn-[a-z0-9-]+$/.test(error.message??'')?error.message:'mnn-rest-failed';
      const terminal=row.attempts>=this.config.maxAttempts||code==='mnn-insufficient-headroom-or-fixed-context';
      this.change(id,terminal?'REST_FAILED':'RECOVERY_PENDING',code,{retry_at:this.now()+this.config.retryMs*2**(row.attempts-1),owner:null,lease:0});
      return {state:this.get(id).state,error:code};
    } finally {clearInterval(renew);}
  }
  close(){this.db.close();}
}
