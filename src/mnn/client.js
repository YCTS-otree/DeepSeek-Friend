import { spawn,spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function mnnSettings(dataDir) {
  const file=path.join(dataDir,'cognitive/mnn/activation.json');
  if(!fs.existsSync(file))return {enabled:false};
  const c=JSON.parse(fs.readFileSync(file,'utf8'));
  if(c.privateRepairPending)throw Error('mnn-private-repair-required');
  if(c.enabled&&(!/^[a-f0-9-]{36}$/.test(c.generation??'')))throw Error('mnn-generation-required');
  if(c.schema!=='dsf-mnn-activation/1'||c.runtimeVersion!=='0.2.0-rc.2'||typeof c.enabled!=='boolean'||typeof c.tokenizer!=='string')throw Error('mnn-activation-invalid');
  return c;
}
export class MnnClient {
  constructor(directory,config,{project=root,python='python'}={}) {Object.assign(this,{directory,config,project,python});this.children=new Set();}
  call(action,args={},signal) {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted)return reject(Error('mnn-cancelled'));
      const policy=this.config.standalone?['--standalone']:['--registry',this.config.registryFile??path.resolve(this.directory,'../..','bridge.sqlite'),'--session-kind',this.config.sessionKind??'conversation','--generation',this.config.generation??''];
      const child=spawn(this.python,['-m','dsf_mnn.production_cli','--directory',this.directory,'--dsf-root',this.project,'--tokenizer',this.config.tokenizer,...policy],
        {env:{...process.env,PYTHONPATH:path.join(this.project,'vendor/dsf-mnn/src'),PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe'],windowsHide:true});
      this.children.add(child);let output='',done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.children.delete(child);error?reject(error):resolve(value);};
      const abort=()=>{this.stopChild(child);finish(Error('mnn-cancelled'));};
      const timer=setTimeout(()=>{this.stopChild(child);finish(Error('mnn-worker-timeout'));},action==='dream'?1800000:45000);timer.unref?.();
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>8*1024*1024){this.stopChild(child);finish(Error('mnn-worker-output-limit'));}});
      child.stderr.on('data',()=>{}); // Raw errors can contain private context; receipts stay local.
      child.on('error',()=>finish(Error('mnn-worker-unavailable')));
      child.stdin.on('error',()=>{});
      child.on('close',code=>{try{const row=JSON.parse(output);if(code||row.error)throw Error(/^[-a-z0-9]+$/.test(row.error??'')?'mnn-'+row.error:'mnn-worker-failed');finish(null,row.result);}catch(error){finish(error.message?.startsWith('mnn-')?error:Error('mnn-worker-protocol'));}});
      const body=JSON.stringify({id:'local',action,...args})+'\n';
      if(Buffer.byteLength(body)>128*1024*1024){this.stopChild(child);finish(Error('mnn-worker-input-limit'));return;}
      child.stdin.end(body);
    });
  }
  stopChild(child){if(child.exitCode!==null||!child.pid)return;if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}
  close(){for(const child of this.children)this.stopChild(child);this.children.clear();}
}
