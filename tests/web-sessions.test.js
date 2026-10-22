import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page() {
  const nodes = new Map();
  function node() { return { children: [], textContent: '', value: '', hidden: false, disabled: false,
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, addEventListener() {},
    querySelector() { return node(); }, classList: { add() {}, remove() {} } }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: get, querySelectorAll: () => [], createElement: node },
    setTimeout() {}, setInterval() {}, fetch: () => new Promise(() => {}) });
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8') + '\nstate = {csrf:"fixture"};', context);
  return { context, get, run: code => vm.runInContext(code, context), respond: fn => { context.fetch = async (_url, request) => ({ ok: true, json: async () => fn(JSON.parse(request.body)) }); } };
}
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
