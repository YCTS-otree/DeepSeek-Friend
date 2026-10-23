import test from 'node:test';
import assert from 'node:assert/strict';
import { NapCatApi, loginView, oneBotConfiguration, gatewayErrorDetail } from '../src/qq-gateway.js';
import { qqImageUrl } from '../src/qq-media.js';

test('NapCat authenticates through actual API contract and never exposes the raw token to QR/status results',async()=>{
  const requests=[];const api=new NapCatApi('SYNTHETIC_TOKEN',{fetcher:async(url,options)=>{requests.push({url,options});const data=url.endsWith('/auth/login')?{Credential:'SYNTHETIC_SESSION'}:url.endsWith('/CheckLoginStatus')?{isLogin:false,coreReady:false,loginPhase:'waiting_qrcode',qrcodeurl:'https://txz.qq.com/p?k=SYNTHETIC_QR'}:null;return new Response(JSON.stringify({code:0,data}),{status:200});}});
  const state=await api.status();assert.ok(state.svg.startsWith('<svg'));assert.equal(state.online,false);assert.ok(!JSON.stringify(state).includes('SYNTHETIC_TOKEN'));
  assert.equal(requests.length,2);assert.ok(!requests[0].url.includes('token'));assert.equal(JSON.parse(requests[0].options.body).hash.length,64);assert.equal(requests[1].options.headers.Authorization,'Bearer SYNTHETIC_SESSION');
  await api.configure('SYNTHETIC_ONEBOT');assert.equal(JSON.parse(JSON.parse(requests[2].options.body).config).network.websocketServers[0].host,'127.0.0.1');
  await assert.rejects(api.request('/File/GetFile'),{code:'qq-gateway-api-denied'});
});
test('QQ QR never treats scanned or partial login as ready, hides QR during confirmation, and rejects external URLs',()=>{
  const raw={qrcodeurl:'https://txz.qq.com/p?k=SYNTHETIC_QR',isLogin:true,coreReady:false,loginPhase:'initializing'};
  assert.equal(loginView(raw).online,false);assert.equal(loginView(raw).svg,null);
  assert.equal(loginView({...raw,isLogin:true,coreReady:true}).online,true);
  assert.throws(()=>loginView({qrcodeurl:'https://evil.example/x'}),{code:'qq-gateway-qr-invalid'});
  assert.equal(oneBotConfiguration('mock').network.websocketClients.length,0);
  for(const url of ['http://gchat.qpic.cn/x','https://127.0.0.1/x','https://example.com/x','https://gchat.qpic.cn:8443/x'])assert.throws(()=>qqImageUrl(url));
});
test('phone confirmation is shown as reported by gateway without a browser cooldown timer',()=>{
  const scanned=loginView({loginPhase:'qrcode_scanned',loginError:'手机端请等待5秒后确认'});
  assert.equal(scanned.phase,'qrcode_scanned');assert.equal(scanned.online,false);assert.equal(scanned.svg,null);
  assert.equal(scanned.errorDetail,'手机端请等待5秒后确认');assert.ok(!Object.hasOwn(scanned,'cooldownSeconds'));
  const ready=loginView({isLogin:true,coreReady:true,loginPhase:'initializing'});assert.equal(ready.phase,'ready');assert.equal(ready.online,true);
});
test('duplicate desktop login retains original diagnostic and never becomes a fabricated successful login',()=>{
  const view=loginView({loginPhase:'waiting_qrcode',loginError:'当前账号(99990000)已登录,无法重复登录'});
  assert.equal(view.phase,'account_in_use');assert.equal(view.online,false);assert.equal(view.errorDetail,'当前账号(99990000)已登录,无法重复登录');
  assert.equal(loginView({loginPhase:'waiting_qrcode'}).errorDetail,'');
});
test('original gateway errors keep useful text while credentials and control bytes are redacted',()=>{
  const safe=gatewayErrorDetail('原始提示 token="SYNTH_TOKEN" cookie=COOKIE_FIXTURE Authorization: Bearer AUTH_FIXTURE password="SYNTH_PASSWORD" https://qq.com/?token=SYNTH_URL');
  assert.ok(safe.includes('原始提示'));for(const secret of ['SYNTH_TOKEN','COOKIE_FIXTURE','AUTH_FIXTURE','SYNTH_PASSWORD','SYNTH_URL'])assert.ok(!safe.includes(secret));
  assert.equal(gatewayErrorDetail('x'.repeat(5000)).length,2000);assert.equal(gatewayErrorDetail({token:'synthetic'}),'');
});
test('upstream API failure preserves sanitized original message alongside stable error code',async()=>{
  const api=new NapCatApi('SYNTHETIC_TOKEN',{fetcher:async()=>new Response(JSON.stringify({code:-1,message:'原始登录提示 token=SYNTH_SECRET'}))});api.credential='SYNTH_SESSION';
  await assert.rejects(api.request('/QQLogin/RefreshQRcode'),e=>{assert.equal(e.code,'qq-gateway-api');assert.ok(e.detail.includes('原始登录提示'));assert.ok(!e.detail.includes('SYNTH_SECRET'));return true;});
});
