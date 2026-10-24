import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('legacy memory mutations cannot report success while leaving the active MNN graph unchanged',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mnn-cli-')),data=path.join(root,'data'),dir=path.join(data,'cognitive/mnn');fs.mkdirSync(dir,{recursive:true});
 const marker=JSON.stringify({schema:'dsf-mnn-activation/1',runtimeVersion:'0.2.0-rc.2',enabled:true,paused:false,tokenizer:'unused'});fs.writeFileSync(path.join(dir,'activation.json'),marker);
 const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({dataDir:data}));
 try{for(const command of ['correct','forget-scope','export','retry','rollback']){
  const r=spawnSync(process.execPath,['scripts/cognitive.js',command,'shared','id','--confirm'],{encoding:'utf8',input:'{}',env:{...process.env,BRIDGE_CONFIG:config},windowsHide:true});
  assert.equal(r.status,1);assert.match(r.stderr,/cognitive-mnn-maintenance-required/);assert.equal(fs.readFileSync(path.join(dir,'activation.json'),'utf8'),marker);
 }assert.equal(fs.existsSync(path.join(data,'cognitive/cognitive.sqlite')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
