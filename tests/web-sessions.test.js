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

test('group management shows escaped names, persists only the selected switch and disables offline changes',async()=>{
 const p=page(),requests=[];let enabled=false;
 p.respond(body=>{requests.push(body);if(body.action==='qq-group-configure'){enabled=body.args.enabled;return{enabled};}return{connected:true,groups:[{id:'1131809600',name:'<script>不是HTML</script>',members:4,enabled}]};});
 await p.run('loadQQGroups()');let row=p.get('qq-groups-list').children[0];assert.match(row.children[0].textContent,/<script>不是HTML<\/script>/);assert.equal(row.children[1].textContent,'启用');
 await row.children[1].listeners.click();assert.equal(enabled,true);assert.ok(requests.some(r=>r.action==='qq-group-configure'&&r.args.groupId==='1131809600'));assert.equal(p.get('qq-groups-list').children[0].children[1].textContent,'停用');
 p.respond(()=>({connected:false,groups:[{id:'1131809600',name:'缓存群',members:4,enabled:true}]}));await p.run('loadQQGroups()');assert.equal(p.get('qq-groups-list').children[0].children[1].disabled,true);assert.match(p.get('qq-groups-notice').textContent,/未连接/);
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
