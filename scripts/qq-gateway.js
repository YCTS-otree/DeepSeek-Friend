import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.js';
import { secureDirectory, loadCredentials, saveCredentials } from '../src/security.js';
import { dataLock } from '../src/lock.js';
import { RuntimeStore } from '../src/runtime.js';
import { NapCatApi, GATEWAY, gatewayErrorDetail } from '../src/qq-gateway.js';
import { sleep, BridgeError } from '../src/util.js';
const root = path.resolve('.'), config = loadConfig(), home = path.join(config.dataDir, 'qq-gateway'), install = path.join(root, '.runtime/qq-gateway', GATEWAY.version);
const ac = new AbortController(); let child, runtime, unlock, last = '', configured = false;
const emit = data => process.stdout.write(JSON.stringify({ event: 'ui.qq', version: GATEWAY.version, ...data }) + '\n');
const stop = () => { ac.abort(); child?.kill(); };
for (const sig of ['SIGINT','SIGTERM']) process.once(sig, stop);
const input = createInterface({ input: process.stdin }); let refreshRequested = false;
input.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.command === 'shutdown') stop(); if (m.command === 'qq-refresh') refreshRequested = true; });
async function unused(port) {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new BridgeError('qq-gateway-port-in-use'))); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
async function main() {
  if (process.platform !== 'win32') throw new BridgeError('qq-gateway-windows-package');
  if (!fs.existsSync(path.join(install,'node.exe')) || !fs.existsSync(path.join(install,'index.js'))) throw new BridgeError('qq-gateway-not-installed');
  secureDirectory(home); unlock = dataLock(home); await unused(GATEWAY.webPort); await unused(GATEWAY.wsPort);
  let secret = loadCredentials(config.dataDir,'qq-gateway-credentials.json');
  if (!secret) { secret = { token: randomBytes(32).toString('hex') }; saveCredentials(config.dataDir,secret,'qq-gateway-credentials.json'); }
  let connection = loadCredentials(config.dataDir,'qq-connection.json');
  if (!connection) { connection = { token: randomBytes(32).toString('hex') }; saveCredentials(config.dataDir,connection,'qq-connection.json'); }
  const conf = path.join(home,'config'); fs.mkdirSync(conf,{recursive:true});
  // These are private gateway configuration files, required by upstream, never logs or release artifacts.
  fs.writeFileSync(path.join(conf,'webui.json'),JSON.stringify({host:'127.0.0.1',port:GATEWAY.webPort,token:secret.token,autoLoginAccount:secret.account??'',disableWebUI:false,loginRate:10,accessControlMode:'whitelist',ipWhitelist:['127.0.0.1','::1'],enableXForwardedFor:false}));
  fs.writeFileSync(path.join(conf,'napcat.json'),JSON.stringify({fileLog:false,consoleLog:false,autoTimeSync:false}));
  for (const d of ['profile','profile/AppData/Roaming','profile/AppData/Local']) fs.mkdirSync(path.join(home,d),{recursive:true});
  const env = {};
  for (const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)']) if (process.env[key]) env[key]=process.env[key];
  Object.assign(env,{USERPROFILE:path.join(home,'profile'),APPDATA:path.join(home,'profile/AppData/Roaming'),LOCALAPPDATA:path.join(home,'profile/AppData/Local'),NAPCAT_WORKDIR:home,NAPCAT_DISABLE_MULTI_PROCESS:'1',NAPCAT_DISABLE_PIPE:'1'});
  runtime = new RuntimeStore(config.dataDir);
  emit({phase:'starting',online:false,svg:null});
  child = spawn(path.join(install,'node.exe'),[path.join(install,'index.js')],{cwd:install,env,windowsHide:true,stdio:['ignore','ignore','ignore']});
  let exited = false; child.once('exit',()=>{exited=true;}); child.once('error',()=>{exited=true;});
  const api = new NapCatApi(secret.token); const started=Date.now(); let readyOnce=false, qrSeen=null, qrSince=0;
  function publish(state,error=null,errorDetail=state.errorDetail) {
    const data={...state,error,errorDetail:gatewayErrorDetail(errorDetail),account:state.online?secret.account??null:null};const serialized=JSON.stringify(data);
    if(serialized!==last){emit(data);last=serialized;}
  }
  while (!ac.signal.aborted && !exited) {
    try {
      if (refreshRequested) { refreshRequested=false; await api.refresh(); configured=false; }
      const state = await api.status();
      // Publish authentication independently of later OneBot/configuration failures.
      publish(state,state.phase==='account_in_use'?'qq-gateway-account-in-use':null);readyOnce=true;
      if(state.svg!==qrSeen){qrSeen=state.svg;qrSince=Date.now();}
      if(state.svg&&state.phase==='waiting_qrcode'&&Date.now()-qrSince>120000){qrSince=Date.now();await api.refresh();continue;}
      if (state.online && !configured) {
        try {
          await api.configure(connection.token);
          runtime.saveChannelSettings('qq',{enabled:true,url:'ws://127.0.0.1:'+GATEWAY.wsPort}); configured=true;
          try {
            const info = await api.request('/QQLogin/GetQQLoginInfo');
            if (/^[1-9]\d{4,11}$/.test(String(info?.uin))) { secret.account=String(info.uin); saveCredentials(config.dataDir,secret,'qq-gateway-credentials.json'); await api.request('/QQLogin/SetQuickLoginQQ',{uin:secret.account}); }
          } catch(e) { publish(state,'qq-gateway-quick-login-save',e.detail??e.message); }
        } catch(e) { publish(state,'qq-gateway-onebot-config',e.detail??e.message); }
      }
      if (!state.online) configured=false;
    } catch (e) {
      if (Date.now()-started>90000&&!readyOnce) throw Object.assign(new BridgeError('qq-gateway-start-timeout'),{detail:e.detail??e.message});
      if (readyOnce) publish({phase:'reconnecting',online:false,svg:null},e.code??'qq-gateway-api',e.detail??e.message);
    }
    await sleep(1500,ac.signal).catch(()=>{});
  }
  if (exited&&!ac.signal.aborted) throw new BridgeError('qq-gateway-exited');
}
main().catch(e=>{emit({phase:'error',online:false,svg:null,error:/^qq-gateway-[a-z-]+$/.test(e.code??'')?e.code:'qq-gateway-start-failed',errorDetail:gatewayErrorDetail(e.detail??e.message)});process.exitCode=1;}).finally(async()=>{stop();if(child&&child.exitCode===null)await new Promise(r=>{const timer=setTimeout(r,3000);child.once('exit',()=>{clearTimeout(timer);r();});});if(runtime?.channelSettings('qq').url==='ws://127.0.0.1:'+GATEWAY.wsPort)runtime.saveChannelSettings('qq',{enabled:false,url:'ws://127.0.0.1:'+GATEWAY.wsPort});runtime?.close();unlock?.();input.close();});
