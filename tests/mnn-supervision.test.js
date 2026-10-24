import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {MnnClient} from '../src/mnn/client.js';
test('Windows cancellation terminates only the owned MNN worker and its transport descendants',{skip:process.platform!=='win32'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mnn-tree-')),module=path.join(root,'vendor/dsf-mnn/src/dsf_mnn');await fs.mkdir(module,{recursive:true});
 await fs.writeFile(path.join(module,'production_cli.py'),`import json,os,subprocess,sys,time\nfrom pathlib import Path\nfolder=Path(sys.argv[sys.argv.index('--directory')+1]);folder.mkdir(parents=True,exist_ok=True)\nchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])\n(folder/'pids.json').write_text(json.dumps({'parent':os.getpid(),'child':child.pid}))\ntime.sleep(120)\n`);
 const dir=path.join(root,'data'),client=new MnnClient(dir,{tokenizer:'unused'},{project:root}),controller=new AbortController();
 const promise=client.call('dream',{},controller.signal).then(()=>null,e=>e.message);let pids;
 try{
  for(let i=0;i<100&&!pids;i++){try{pids=JSON.parse(await fs.readFile(path.join(dir,'pids.json'),'utf8'));}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.ok(pids);controller.abort();assert.equal(await promise,'mnn-cancelled');
  for(const pid of [pids.parent,pids.child]){let alive=true;for(let i=0;i<40&&alive;i++){try{process.kill(pid,0);}catch{alive=false;}if(alive)await new Promise(r=>setTimeout(r,50));}assert.equal(alive,false);}
 }finally{client.close();await fs.rm(root,{recursive:true,force:true});}
});
