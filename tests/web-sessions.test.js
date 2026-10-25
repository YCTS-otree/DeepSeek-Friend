import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page() {
  const nodes = new Map();
  function node() { return { children: [], firstChild: { textContent: '' }, textContent: '', value: '', hidden: false, disabled: false,
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, listeners: {}, addEventListener(name,handler) {this.listeners[name]=handler;},
    removeAttribute(name) { delete this[name]; },
    querySelector() { return node(); }, classList: { add() {}, remove() {} } }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: get, querySelectorAll: () => [], createElement: node },
    setTimeout() {}, setInterval() {}, fetch: () => new Promise(() => {}) });
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8') + '\nstate = {csrf:"fixture"};', context);
  return { context, get, run: code => vm.runInContext(code, context), respond: fn => { context.fetch = async (_url, request) => ({ ok: true, json: async () => fn(JSON.parse(request.body)) }); } };
}
test('dashboard shows native pressure, cache-inclusive usage, real balance and the separate inference pause',async()=>{
 const p=page();p.run('state={csrf:"fixture",bridge:"ready",dsh:"ready",login:"ready",qqLogin:"ready"};');
 p.respond(()=>({updated:1792886400000,native:{status:'ready',context:{projectedTokens:390,contextWindow:1000},tokens:{uncachedInputTokens:10,cacheReadTokens:20,cacheWriteTokens:0,outputTokens:4}},runtime:{paused:true,continuous:true,reasoningEffort:'max',maxTokens:8192},balance:{status:'ready',available:true,balances:[{currency:'CNY',total_balance:'12.34'}]},jobs:[],deliveries:[],session:{title:'original'}}));
 await p.run('loadDashboard()');assert.equal(p.get('dash-pressure').textContent,'39.0%');assert.equal(p.get('dash-tokens').textContent,'34');assert.equal(p.get('dash-balance').textContent,'¥ 12.34');assert.equal(p.get('dash-agent').textContent,'推理已暂停');assert.equal(p.get('dashboard-alert').hidden,false);
 p.respond(()=>({native:{status:'error'},balance:{status:'error',error:'balance-query-failed'}}));await p.run('loadDashboard()');assert.equal(p.get('dash-balance').textContent,'暂不可用');
});
test('archive relative ages show minutes, hours and combined days with stable invalid/future handling',()=>{
 const p=page();const now=Date.parse('2026-10-24T12:00:00Z');p.context.ageNow=now;
 assert.equal(p.run('archiveAge(new Date(ageNow-60000).toISOString(),ageNow)'),'1分钟前');
 assert.equal(p.run('archiveAge(new Date(ageNow-3600000).toISOString(),ageNow)'),'1小时前');
 assert.equal(p.run('archiveAge(new Date(ageNow-90000000).toISOString(),ageNow)'),'1天1小时前');
 assert.equal(p.run('archiveAge("bad",ageNow)'),'时间未知');
});

test('independent compatibility report blocks whole rollback when one format needs a missing migration',async()=>{
 const p=page(),calls=[];
 const rows=[['dsh_context',true],['bridge_state',true],['cognitive_state',false],['room',true]].map(([id,canRestore])=>({id,label:id,canRestore,status:canRestore?'compatible':'migration-required',source:{format:id,version:1},target:{format:id,version:canRestore?1:2},migrations:[]}));
 p.respond(body=>{calls.push(body);return{appVersion:'1.9.1',compatibility:{canRestore:false,components:rows,dependencies:[]}};});
 await p.run('openArchiveCompatibility("old.DSF")');
 assert.equal(p.get('archive-compatibility-confirm').disabled,true);
 assert.match(p.get('archive-components').children[0].textContent,/兼容，无需迁移/);
 assert.match(p.get('archive-components').children[2].textContent,/需要迁移器/);
 await p.get('archive-compatibility-confirm').listeners.click();
 assert.ok(!calls.some(c=>c.action==='restore-begin'));assert.equal(p.get('archive-components').children.length,4);
});

test('whole rollback checks independent versions and plans only the changed memory format migration',async()=>{
 const p=page(),calls=[];
 const rows=['dsh_context','bridge_state','cognitive_state','room'].map(id=>({id,label:id,canRestore:true,status:id==='cognitive_state'?'migration-planned':'compatible',source:{format:id,version:1},target:{format:id,version:id==='cognitive_state'?2:1},migrations:id==='cognitive_state'?['memory-v2']:[]}));
 p.respond(body=>{calls.push(body);if(body.action==='restore-options')return{appVersion:'1.9.1',compatibility:{canRestore:true,components:rows}};return{id:'plan',name:'old.DSF',nonce:'step1',step:1,waitMs:3000,components:rows.map(r=>r.id),componentLabels:rows.map(r=>r.id),migrations:['memory-v2']};});
 await p.run('openArchiveCompatibility("old.DSF")');assert.equal(p.get('archive-compatibility-confirm').disabled,false);
 assert.match(p.get('archive-components').children[2].textContent,/恢复时迁移：memory-v2/);
 await p.get('archive-compatibility-confirm').listeners.click();
 assert.deepEqual(calls.find(c=>c.action==='restore-begin').args,{name:'old.DSF'});
 assert.match(p.get('archive-confirm-warning').textContent,/恢复整份快照/);assert.match(p.get('archive-confirm-warning').textContent,/memory-v2/);assert.equal(p.get('archive-confirm').disabled,true);
 const html=fs.readFileSync('web/index.html','utf8');const report=html.slice(html.indexOf('id="archive-compatibility"'),html.indexOf('id="archive-confirmation"'));
 assert.ok(!report.includes('type="checkbox"'));
});

test('group management shows escaped names, persists only the selected switch and disables offline changes',async()=>{
 const p=page(),requests=[];let enabled=false;
 p.respond(body=>{requests.push(body);if(body.action==='qq-group-configure'){enabled=body.args.enabled;return{enabled};}return{connected:true,groups:[{id:'1131809600',name:'<script>不是HTML</script>',members:4,enabled}]};});
 await p.run('loadQQGroups()');let row=p.get('qq-groups-list').children[0];assert.match(row.children[0].textContent,/<script>不是HTML<\/script>/);assert.equal(row.children[1].textContent,'启用');
 await row.children[1].listeners.click();assert.equal(enabled,true);assert.ok(requests.some(r=>r.action==='qq-group-configure'&&r.args.groupId==='1131809600'));assert.equal(p.get('qq-groups-list').children[0].children[1].textContent,'停用');
 p.respond(()=>({connected:false,groups:[{id:'1131809600',name:'缓存群',members:4,enabled:true}]}));await p.run('loadQQGroups()');assert.equal(p.get('qq-groups-list').children[0].children[1].disabled,true);assert.match(p.get('qq-groups-notice').textContent,/未连接/);
});

test('each restore confirmation restarts its own 3-second disabled period; early clicks send nothing',async()=>{
 const p=page(),calls=[];let step=1;
 p.respond(body=>{calls.push(body);if(body.action==='restore-confirm')return{step:++step,id:'plan',nonce:'nonce'+step,name:'fixture.DSF',waitMs:3000};return{};});
 p.run('showArchivePlan({step:1,id:"plan",nonce:"nonce1",name:"fixture.DSF",waitMs:3000})');
 for(const expected of [1,2]){
   assert.equal(p.get('archive-confirm').disabled,true);await p.get('archive-confirm').listeners.click();assert.equal(calls.length,expected-1);
   p.run('archiveReadyAt=Date.now()-1;archiveCountdown()');assert.equal(p.get('archive-confirm').disabled,false);
   await p.get('archive-confirm').listeners.click();assert.equal(p.run('archivePlan.step'),expected+1);assert.equal(p.get('archive-confirm').disabled,true);
 }
 assert.match(p.get('archive-confirm-warning').textContent,/保存.*当前状态/);
 p.respond(body=>body.action==='restore-cancel'?{cancelled:true}:{});await p.get('archive-cancel').listeners.click();assert.equal(p.get('archive-confirmation').hidden,true);assert.equal(p.run('archivePlan'),null);
});

test('feature settings await the completed checkpoint operation and propagate snapshot failure',async()=>{
 const p=page();p.respond(body=>body.action==='qq-group-configure'?{archiveOperation:'op'}:{state:'done',progress:'已完成',result:{archive:'before.DSF',value:{enabled:true}}});
 assert.equal((await p.run('sessionRequest("qq-group-configure",{enabled:true,groupId:"1131809600"})')).enabled,true);
 p.respond(body=>body.action==='qq-group-configure'?{archiveOperation:'failed'}:{state:'failed',progress:'已停止',error:'dsf-operation-failed'});
 await assert.rejects(p.run('sessionRequest("qq-group-configure",{enabled:true,groupId:"1131809600"})'),/dsf-operation-failed/);
});
test('selecting an empty archived session clears the previous session transcript immediately', async () => {
  const p = page(); p.run('selectSession("a"); historyEntries = [{n:1,role:"assistant",actor:{},text:"private to A",created:1}]; renderHistory();');
  assert.equal(p.get('chat-history').children.length, 1);
  p.run('selectSession("b")'); assert.equal(p.get('chat-history').children.length, 0);
  p.respond(() => ({ entries: [], hasMore: false })); await p.run('loadHistory()');
  assert.equal(p.get('chat-history').children.length, 0);
});
test('new-session selection cannot merge the previous 100+ history entries into the new session', async () => {
  const p = page(); p.run('selectSession("a"); historyEntries = Array.from({length:130},(_,i)=>({n:i,role:"user",actor:{},text:"old",created:1})); selectSession("b");');
  p.respond(() => ({ entries: [{ n: 150, role: 'assistant', actor: {}, text: 'new session only', created: 2 }], hasMore: false }));
  await p.run('loadHistory()'); assert.equal(p.run('historyEntries.length'), 1);
  assert.equal(p.run('historyEntries[0].text'), 'new session only');
});
test('late history responses from a previously selected session never appear in the current one', async () => {
  const p = page(); let finish;
  p.context.fetch = () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ entries: [{ n: 1, role: 'assistant', text: 'old', actor: {}, created: 1 }], hasMore: false }) }); });
  p.run('selectSession("a")'); const loading = p.run('loadHistory()'); p.run('selectSession("b")'); finish(); await loading;
  assert.equal(p.run('historyEntries.length'), 0); assert.equal(p.get('chat-history').children.length, 0);
});

test('switching selected sessions clears private thought and Prompt views and ignores a late Prompt', async () => {
  const p = page(); let finish;
  p.run('selectSession("a"); thoughtEntries=[{n:1}]; document.getElementById("thought-records").append({textContent:"A private"});');
  p.context.fetch = () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ core: 'A private prompt' }) }); });
  const loading = p.run('loadPrompts()'); p.run('selectSession("b")'); finish(); await loading;
  assert.equal(p.get('thought-records').children.length, 0);
  assert.equal(p.run('promptData'), null); assert.ok(!p.get('prompt-content').textContent.includes('A private'));
});

test('older thought pages remain visible during refresh and user content is rendered as text', async () => {
  const p = page(); p.run('selectSession("a"); thoughtEntries=Array.from({length:40},(_,i)=>({n:i+1,kind:"note",text:"note",created:1}));');
  p.respond(() => ({ entries: [{ n: 41, kind: 'note', text: '<img onerror=bad>', created: 2 }], hasMore: true }));
  await p.run('loadThoughts()'); assert.equal(p.run('thoughtEntries.length'), 41);
  assert.equal(p.get('thought-records').children.at(-1).children[1].textContent, '<img onerror=bad>');
});

test('homepage distinguishes QQ Bot from QQ Bridge and keeps one-click start available for a stopped Bot', async () => {
  const p=page();p.run('state={csrf:"fixture",version:"1.6.0",baseUrl:"http://127.0.0.1:3088",dsh:"ready",bridge:"ready",login:"ready",qqGateway:"stopped",qqLogin:"idle",logs:[]};render(state);');
  assert.equal(p.get('start').disabled,false);assert.equal(p.get('qq-gateway-state').textContent,'已停止');assert.equal(p.get('qq-bridge-state').textContent,'等待 QQ 登录');
  p.run('render({...state,qqGateway:"ready",qqLogin:"ready"})');
  assert.equal(p.get('start').disabled,true);assert.equal(p.get('qq-gateway-state').textContent,'运行中 · 已登录');
  p.respond(()=>({qq:{state:'connected',settings:{},friends:2,tokenSaved:true}}));await p.run('loadChannelStatus()');
  assert.equal(p.get('qq-bridge-state').textContent,'已连接');
  const html=fs.readFileSync('web/index.html','utf8'),overview=html.slice(html.indexOf('data-page="overview"'),html.indexOf('data-page="sessions"'));
  for(const id of ['qq-qr','qr','qq-gateway-start','qq-gateway-state','qq-bridge-state'])assert.ok(overview.includes(`id="${id}"`));
  assert.equal((html.match(/id="qq-qr"/g)??[]).length,1);
});
test('homepage mirrors native login and displays original error as text without imposing phone cooldown',()=>{
  const p=page();p.run('state={csrf:"fixture",version:"1.6.2",baseUrl:"http://127.0.0.1:3088",dsh:"ready",bridge:"ready",login:"ready",qqGateway:"ready",qqLogin:"qrcode_scanned",qqErrorDetail:"<img onerror=bad> 原始提示",qqHasQr:false,logs:[]};render(state)');
  assert.match(p.get('qq-login-status').textContent,/已扫码/);assert.ok(!p.get('qq-login-status').textContent.includes('冷静期'));
  assert.equal(p.get('qq-gateway-refresh').disabled,false);assert.equal(p.get('qq-error-detail').textContent,'<img onerror=bad> 原始提示');assert.equal(p.get('qq-error-detail').hidden,false);
  p.run('render({...state,qqLogin:"ready",qqErrorDetail:""})');assert.equal(p.get('qq-error-detail').hidden,true);assert.equal(p.get('qq-placeholder-title').textContent,'QQ 已连接');assert.equal(p.get('qq-gateway-refresh').disabled,true);
});
test('homepage explains account conflict but retains successful login when only OneBot configuration fails',()=>{
  const p=page();p.run('state={csrf:"fixture",version:"1.6.1",baseUrl:"http://127.0.0.1:3088",dsh:"ready",bridge:"ready",login:"ready",qqGateway:"ready",qqLogin:"account_in_use",qqError:"qq-gateway-account-in-use",qqHasQr:true,logs:[]};render(state)');
  assert.match(p.get('qq-login-status').textContent,/退出该机器人账号/);assert.equal(p.get('qq-login-badge').textContent,'账号占用');assert.equal(p.get('qq-qr').hidden,true);
  p.run('render({...state,qqLogin:"ready",qqError:"qq-gateway-onebot-config",qqHasQr:false})');
  assert.equal(p.get('qq-login-badge').textContent,'已登录');assert.match(p.get('qq-login-status').textContent,/QQ 已登录.*配置尚未成功/);
});
