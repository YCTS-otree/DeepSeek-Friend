import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { RuntimeStore } from '../src/runtime.js';
import { installInteraction } from '../dsh/interaction.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { control } from '../src/controls.js';
import { FakeDsh, account, incoming, turn, event } from './helpers.js';

function fixture(t, cognitive = false) {
  const dir = path.resolve('.research/runtime-tests', randomUUID()); fs.mkdirSync(dir, { recursive: true });
  const c = loadConfig('config.example.json', {}); c.dataDir = dir; c.dsh.cwd = path.join(dir, 'work'); c.cognitive.enabled = cognitive;
  const store = new Store(path.join(dir, 'bridge.sqlite')), dsh = new FakeDsh(), ac = new AbortController(), sent = [];
  const ilink = { send: async body => { sent.push(body); return {}; } };
  const engine = new Engine(c, store, dsh, ilink, account, ac.signal), runtime = engine.runtime;
  t.after(async () => { ac.abort(); await engine.drain(); await engine.cognitive?.close(); await engine.testCognitive?.close(); runtime.close(); store.close(); });
  const hooks = new Map(), tools = new Map();
  installInteraction({ systemPrompt: { section() {} }, on: (n, f) => hooks.set(n, f), tools: { register: s => tools.set(s.name, s), schemas: () => [...tools.values()] } }, runtime);
  return { dir, config: c, store, dsh, engine, runtime, hooks, tools, sent, signal: ac.signal,
    ingest: (...msgs) => store.ingest(account.accountId, { msgs }, new Set(['alice', 'bob']), 16000, { imagesEnabled: true }),
    job: id => store.db.prepare('SELECT * FROM jobs WHERE message_id=?').get(id),
    control: (action, args) => control({ store, runtime, config: c, engine }, action, args) };
}
test('runtime pins actual Flash route and hot-applies depth and per-request cap without a cumulative budget', async t => {
  const f = fixture(t); f.runtime.configure({ reasoningEffort: 'max', maxTokens: 4096 });
  const result = await f.hooks.get('agent/request')({}, async () => ({ provider: 'other', model: 'pro', maxTokens: 1 }));
  assert.deepEqual(result, { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: 'max' });
  assert.throws(() => f.runtime.configure({ maxSteps: 1 }), { code: 'runtime-settings-invalid' });
  assert.throws(() => f.runtime.configure({ reasoningEffort: 'ultra' }));
  const reopened = new RuntimeStore(f.dir); try { assert.equal(reopened.settings().reasoningEffort, 'max'); } finally { reopened.close(); }
});

test('tool-less legacy declarations rebase once via the native request-series boundary without replacing messages', async t => {
  const f = fixture(t), messages = [{ role: 'user', content: 'retained' }], decision = { kind: 'enter', messages };
  let tools = [], header = {};
  const agent = { id: 'legacy-session', session: { requestHeader: () => header, toolHistory: () => ({ tools, updates: [{ additions: [{ name: 'weixin_send_message' }] }] }) } };
  const hook = f.hooks.get('agent/pre-step');
  const rebased = await hook({ agent }, async () => decision); assert.equal(rebased.startsRequestSeries, true); assert.equal(rebased.messages, messages);
  tools = [...f.tools.keys()].map(name => ({ name })); assert.equal(await hook({ agent }, async () => decision), decision);
  tools = [{ name: 'retired_tool' }]; assert.equal((await hook({ agent }, async () => decision)).startsRequestSeries, true);
  tools = []; header = undefined; assert.equal(await hook({ agent }, async () => decision), decision);
  header = {}; const rejected = { kind: 'reject' }; assert.equal(await hook({ agent }, async () => rejected), rejected);
});
test('one turn can emit several durable messages while private notes/reasoning never enter Weixin', async t => {
  const f = fixture(t); f.ingest(incoming('hello', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  f.runtime.emit(j.session, 'first-send', '第一条'); f.runtime.emit(j.session, 'second-send', '第二条');
  f.runtime.emit(j.session, 'first-send', '第一条');
  await f.engine.flushEmissions(); await f.engine.flushEmissions();
  const events = turn(j.request_id, 'PRIVATE-NOTE');
  for (const e of events) await f.engine.onSession(j.session, e);
  while (await f.engine.sendOne()) { /* mocked transport */ }
  assert.deepEqual(f.sent.map(r => r.msg.item_list[0].text_item.text), ['第一条', '第二条']);
  const history = f.store.sessionControl('history', { session: j.session }).entries;
  assert.deepEqual(history.filter(r => r.role === 'assistant').map(r => r.text), ['第一条', '第二条']);
  assert.ok(!JSON.stringify(history).includes('PRIVATE')); assert.ok(!JSON.stringify(f.sent).includes('SECRET'));
  const thoughts = f.runtime.thoughts(j.session).entries;
  assert.ok(thoughts.some(r => r.kind === 'reasoning' && r.text.includes('SECRET-THOUGHT')));
  assert.ok(thoughts.some(r => r.kind === 'note' && r.text === 'PRIVATE-NOTE'));
});

test('failed model turns retain a safe code in status after completion without exposing provider messages', async t => {
  const f = fixture(t); f.ingest(incoming('failure', 'failure')); await f.engine.submit(f.job('failure')); const j = f.job('failure');
  const records = turn(j.request_id); records.at(-1).event.data.reason = { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'PRIVATE-PROVIDER-DETAIL' } };
  for (const record of records) await f.engine.onSession(j.session, record);
  assert.equal(f.job('failure').state, 'done'); assert.equal(f.job('failure').error, 'dsh-agent-INVALID_REQUEST');
  assert.equal(f.store.stats().issues[0].error, 'dsh-agent-INVALID_REQUEST');
  assert.ok(!JSON.stringify(f.store.stats()).includes('PRIVATE-PROVIDER'));
  const status = await f.control('runtime-status'); assert.equal(status.jobs[0].error, 'dsh-agent-INVALID_REQUEST');
});
test('pre-admission failure can reopen its route; admitted private routes never reopen', async t => {
  const f=fixture(t);f.ingest(incoming('hello','reopen'));await f.engine.submit(f.job('reopen'));const j=f.job('reopen');
  f.runtime.db.prepare('UPDATE reply_routes SET closed=1,is_private=1 WHERE job=?').run(j.id);
  f.runtime.prepareReply(j.session,j.request_id);
  assert.equal(f.runtime.db.prepare('SELECT closed FROM reply_routes WHERE job=?').get(j.id).closed,0);
  for(const frame of turn(j.request_id,'恢复后的正常回复'))await f.engine.onSession(j.session,frame);
  await f.engine.flushEmissions();while(await f.engine.sendOne()){}
  assert.equal(f.sent.length,1);
  f.runtime.db.prepare('UPDATE reply_routes SET is_private=1 WHERE job=?').run(j.id);
  f.runtime.prepareReply(j.session,j.request_id);
  assert.deepEqual({...f.runtime.db.prepare('SELECT closed,is_private FROM reply_routes WHERE job=?').get(j.id)},{closed:1,is_private:1});
});

test('ordinary response reaches Weixin once, retains both sides of chat and never sends reasoning', async t => {
  const f = fixture(t); f.ingest(incoming('hello', 'normal')); await f.engine.submit(f.job('normal')); const j = f.job('normal');
  for (const frame of turn(j.request_id, '正常回复')) await f.engine.onSession(j.session, frame);
  const reopened = new RuntimeStore(f.dir); try { reopened.finishReply(j.session); } finally { reopened.close(); }
  await f.engine.flushEmissions(); await f.engine.flushEmissions(); while (await f.engine.sendOne()) {}
  assert.deepEqual(f.sent.map(r => r.msg.item_list[0].text_item.text), ['正常回复']);
  assert.ok(f.store.sessionControl('history', { session: j.session }).entries.some(e => e.role === 'assistant' && e.text === '正常回复'));
  assert.ok(!JSON.stringify(f.sent).includes('SECRET'));
});

test('reply is delivered before autonomous continuation, whose text and explicit private notes stay private', async t => {
  const f = fixture(t); f.runtime.configure({ continueDelayMs: 0 }); f.ingest(incoming('hello', 'continue')); await f.engine.submit(f.job('continue')); const j = f.job('continue');
  for (const frame of turn(j.request_id, '先回复').slice(0, 3)) await f.engine.onSession(j.session, frame);
  let injected = false;
  await f.hooks.get('agent/turn-stopping')({ agent: { id: j.session, inject: () => { injected = true; } }, signal: f.signal });
  assert.equal(injected, true); await f.engine.flushEmissions(); await f.engine.sendOne(); assert.equal(f.sent.length, 1);
  for (const frame of [event(3, 'user/message', { source: { kind: 'friend-continuation' } }), event(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'PRIVATE-CONTINUATION' }] } }), event(5, 'tool/call', { turn: 1, name: 'private_note', arguments: JSON.stringify({ text: 'PRIVATE-TOOL-NOTE' }) }), event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]) await f.engine.onSession(j.session, frame);
  await f.engine.flushEmissions(); assert.equal(await f.engine.sendOne(), false);
  assert.ok(f.runtime.thoughts(j.session).entries.some(r => r.text === 'PRIVATE-CONTINUATION'));
  assert.ok(f.runtime.thoughts(j.session).entries.some(r => r.text === 'PRIVATE-TOOL-NOTE'));
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE'));
});

test('stopping without continuous mode still sends ordinary replies; private-only, alarm and historical notes are not promoted', async t => {
  const f = fixture(t); f.runtime.configure({ continuous: false }); f.ingest(incoming('hello', 'boundary')); await f.engine.submit(f.job('boundary')); const j = f.job('boundary');
  for (const frame of turn(j.request_id, '正常结束').slice(0, 3)) await f.engine.onSession(j.session, frame);
  await f.hooks.get('agent/turn-stopping')({ agent: { id: j.session, inject: () => assert.fail('disabled continuation') }, signal: f.signal });
  assert.equal(f.runtime.db.prepare('SELECT count(*) n FROM emissions').get().n, 1);
  f.runtime.bind(j.session, 'private-only', 'test', null, 'private-request');
  f.runtime.record(j.session, event(20, 'user/message', { source: { rpcId: 'old-request' } }).event);
  f.runtime.record(j.session, event(21, 'assistant/message', { message: { content: [{ type: 'text', text: 'HISTORICAL' }] } }).event);
  f.runtime.finishReply(j.session);
  f.runtime.bind(j.session, 'alarm', 'alarm'); f.runtime.record(j.session, event(30, 'assistant/message', { message: { content: [{ type: 'text', text: 'PRIVATE-ALARM' }] } }).event); f.runtime.finishReply(j.session);
  assert.equal(f.runtime.db.prepare('SELECT count(*) n FROM emissions').get().n, 1);
});

test('choosing private_note suppresses even an accidental closing body, but explicit outward messages remain possible', async t => {
  const f = fixture(t); f.ingest(incoming('hello', 'private')); await f.engine.submit(f.job('private')); const j = f.job('private');
  const frames = turn(j.request_id, 'PRIVATE-CLOSING-BODY');
  for (const frame of frames.slice(0, 2)) await f.engine.onSession(j.session, frame);
  await f.engine.onSession(j.session, event(2, 'tool/call', { name: 'private_note', arguments: JSON.stringify({ text: 'PRIVATE-EXPLICIT-NOTE' }) }));
  const body = frames[2]; body.event.seq = 3; await f.engine.onSession(j.session, body);
  frames[3].event.seq = 4; await f.engine.onSession(j.session, frames[3]);
  await f.engine.flushEmissions(); assert.equal(await f.engine.sendOne(), false);
  f.runtime.emit(j.session, 'chosen-public', '明确对外'); await f.engine.flushEmissions(); await f.engine.sendOne();
  assert.deepEqual(f.sent.map(r => r.msg.item_list[0].text_item.text), ['明确对外']);
});
test('native stopping hook continues without a step/token counter; rest and new input preemption both stop continuation', async t => {
  const f = fixture(t); f.runtime.configure({ continueDelayMs: 0 });
  const sid = f.store.ensureMapping('a', 'u').session; f.runtime.bind(sid, 'job'); let injections = 0;
  const agent = { id: sid, inject: message => { injections++; assert.equal(message.role, 'user'); } };
  for (let i = 0; i < 12; i++) await f.hooks.get('agent/turn-stopping')({ agent, signal: f.signal });
  assert.equal(injections, 12); f.runtime.flag(sid, 'rest'); await f.hooks.get('agent/turn-stopping')({ agent, signal: f.signal }); assert.equal(injections, 12);
  f.runtime.bind(sid, 'next'); f.runtime.flag(sid, 'preempt'); await f.hooks.get('agent/turn-stopping')({ agent, signal: f.signal }); assert.equal(injections, 12);
});
test('continuous turns do not time out on the former whole-turn timeout; newly queued user input gets a boundary', async t => {
  const f = fixture(t); f.ingest(incoming('old', 'old')); await f.engine.submit(f.job('old')); const sid = f.job('old').session;
  f.store.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(1, f.job('old').id);
  f.ingest(incoming('new', 'new')); await f.engine.tick(); await f.engine.drain();
  assert.equal(f.job('old').state, 'waiting'); assert.equal(f.runtime.context(sid).preempt, 1);
  assert.ok(!f.dsh.calls.some(c => c.endpoint === 'session/cancel'));
});

test('image-only messages use native DSH image blocks and retry exactly the persisted image/text request', async t => {
  const f = fixture(t); f.ingest(incoming('', 'picture', 'alice', { item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'fixture' } } }] }));
  let downloads = 0; f.engine.media.receive = async () => { downloads++; return { id: 'img-fixture', mediaType: 'image/png', data: 'BASE64_FIXTURE' }; };
  const rpc = f.dsh.rpc.bind(f.dsh); let first = true;
  f.dsh.rpc = async (endpoint, args) => { const result = await rpc(endpoint, args); if (endpoint === 'session/prompt' && first) { first = false; throw Object.assign(Error(), { code: 'network', retryable: true }); } return result; };
  await f.engine.submit(f.job('picture')); await f.engine.submit(f.job('picture'));
  const calls = f.dsh.calls.filter(c => c.endpoint === 'session/prompt'); assert.equal(downloads, 1); assert.equal(calls.length, 2); assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(calls[0].args.content[1].type, 'image'); assert.equal(calls[0].args.content[1].data, 'BASE64_FIXTURE'); assert.match(calls[0].args.content[0].text, /img-fixture/);
});

test('rejected image counts retain the cursor and return an actionable notice', t => {
  const f = fixture(t); f.ingest(incoming('', 'too-many', 'alice', { item_list: Array.from({ length: 5 }, () => ({ type: 2, image_item: { media: {} } })) }));
  assert.equal(f.job('too-many').state, 'rejected'); assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n, 1);
});
test('alarms require no reason, survive restart, catch up once and may proactively contact a known authorized recipient', async t => {
  const f = fixture(t); f.ingest(incoming('contact', 'seed')); await f.engine.submit(f.job('seed'));
  const sid = f.job('seed').session; f.store.updateJob(f.job('seed').id, 'done');
  const alarm = f.runtime.alarm(sid, 'clock', new Date(Date.now() + 10000).toISOString()); assert.equal(alarm.note, '');
  const reopened = new RuntimeStore(f.dir); try { assert.equal(reopened.alarms(sid)[0].id, alarm.id); } finally { reopened.close(); }
  f.engine.scheduleAlarms(Date.now() + 20000); f.engine.scheduleAlarms(Date.now() + 30000);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='alarm'").get().n, 1);
  const j = f.store.db.prepare("SELECT * FROM jobs WHERE kind='alarm'").get(); await f.engine.submit(j);
  f.runtime.emit(sid, 'proactive', '我想和你说一声。'); await f.engine.flushEmissions(); await f.engine.sendOne();
  assert.equal(f.sent[0].msg.to_user_id, 'alice'); assert.equal(f.sent[0].msg.context_token, 'fake-context');
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, '我想和你说一声。');
  assert.throws(() => f.runtime.emit(sid, 'unknown', 'hello', null, 'unknown-contact'), { code: 'known-contact-required' });
});

test('proactive messages require a retained legal context and do not regenerate IDs after an ambiguous send', async t => {
  const f = fixture(t), sid = f.store.ensureMapping('bot-test', 'alice').session; f.runtime.bind(sid, 'no-contact', 'alarm');
  assert.throws(() => f.runtime.emit(sid, 'unavailable', 'hello'), { code: 'known-contact-required' });
  f.ingest(incoming('contact', 'inbound')); await f.engine.submit(f.job('inbound'));
  f.runtime.bind(sid, 'wake', 'alarm');
  // Alarm job and delivery job differ, but the transport body is pinned to the original legal contact.
  f.store.db.prepare("INSERT INTO jobs(id,account,user,message_id,payload,request_id,state,session,created,updated,kind) VALUES('wake','bot-test','alice','wake','{}','wake','waiting',?,1,1,'alarm')").run(sid);
  f.runtime.emit(sid, 'send', '主动联系'); await f.engine.flushEmissions();
  f.engine.ilink.send = async () => { throw Object.assign(Error(), { code: 'send-timeout', ambiguous: true }); };
  await f.engine.sendOne(); const body = f.store.db.prepare('SELECT body,state FROM outbox').get(); assert.equal(body.state, 'unknown');
  f.runtime.emit(sid, 'send', '主动联系'); await f.engine.flushEmissions(); assert.equal(await f.engine.sendOne(), false);
  assert.equal(f.store.db.prepare('SELECT body FROM outbox').get().body, body.body);
});

test('current sender stays selected after another contact arrives; revoked recipients are blocked at admission', async t => {
  const f = fixture(t); f.ingest(incoming('alice', 'alice')); await f.engine.submit(f.job('alice'));
  f.ingest(incoming('bob', 'bob', 'bob')); f.runtime.rememberContact(f.job('bob'));
  const sid = f.job('alice').session; f.runtime.emit(sid, 'default', '给当前交互对象'); await f.engine.flushEmissions();
  assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM outbox').get().body).msg.to_user_id, 'alice');
  const bob = f.runtime.contacts().find(c => c.user === 'bob'); f.runtime.emit(sid, 'revoked', '不能送达被撤销的联系人', null, bob.id); await f.engine.flushEmissions();
  assert.equal(f.runtime.db.prepare("SELECT state FROM emissions WHERE id LIKE '%:revoked'").get().state, 'blocked');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n, 1);
});
test('archived and paused alarms remain pending, and user work is not interrupted', t => {
  const f = fixture(t), sid = f.store.ensureMapping('a', 'u').session; f.runtime.bind(sid, 'seed');
  f.runtime.alarm(sid, 'clock', new Date(Date.now() + 10000).toISOString());
  f.runtime.configure({ paused: true }); f.engine.scheduleAlarms(Date.now() + 20000); assert.equal(f.runtime.alarms(sid)[0].state, 'scheduled');
  f.runtime.configure({ paused: false }); f.store.sessionControl('create'); f.engine.scheduleAlarms(Date.now() + 20000); assert.equal(f.runtime.alarms(sid)[0].state, 'scheduled');
});
test('independent test chat cannot send to Weixin, shares no production Self, and can clear its records only', async t => {
  const f = fixture(t, true); const production = f.store.ensureMapping('bot-test', 'alice').session;
  const productionScope = f.engine.cognitive.store.scope(); const identity = f.engine.cognitive.store.current(productionScope).model.identity.id;
  const sid = (await f.control('create', { kind: 'test', title: '隔离测试' })).session;
  const queued = await f.control('test-send', { session: sid, text: '只在测试中运行' }); await f.engine.submit(f.store.job(queued.queued));
  assert.equal(f.dsh.calls.find(c => c.endpoint === 'session/create').args.agentPreset, 'weixin-test');
  f.runtime.emit(sid, 'test-output', 'test reply'); await f.engine.flushEmissions();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n, 0);
  assert.equal(f.store.currentSession().session, production);
  assert.notEqual(f.engine.testCognitive.store.current(f.engine.testCognitive.store.scope()).model.identity.id, identity);
  const prompts = await f.control('prompts', { session: sid }); assert.notEqual(prompts.self.model.identity.id, identity);
  const cleared = await f.control('test-clear', { confirm: true }); assert.equal(cleared.cleared, 1); assert.equal(f.store.session(sid), undefined);
  assert.equal(f.engine.cognitive.store.current(productionScope).model.identity.id, identity);
  assert.equal(f.store.currentSession().session, production);
  assert.throws(() => f.store.db.prepare('DELETE FROM chat_sessions WHERE session=?').run(production), /archived-not-deleted/);
});

test('test /cancel cannot cancel production jobs or send a Weixin control notice', async t => {
  const f = fixture(t); f.ingest(incoming('production', 'production')); await f.engine.submit(f.job('production'));
  const production = f.job('production'), sid = (await f.control('create', { kind: 'test' })).session;
  const testJob = await f.control('test-send', { session: sid, text: '/cancel' }); await f.engine.command(f.store.job(testJob.queued));
  assert.equal(f.store.job(production.id).state, 'waiting');
  assert.ok(f.dsh.calls.filter(c => c.endpoint === 'session/cancel').every(c => c.args.sessionId === sid));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n, 0);
});

test('offline test clear refuses a still-listening DSH before touching test records', async t => {
  const f = fixture(t), sid = (await f.control('create', { kind: 'test' })).session;
  const server = createServer(socket => socket.destroy()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { ...f.config, dsh: { ...f.config.dsh, baseUrl: 'http://127.0.0.1:' + server.address().port } };
    await assert.rejects(control({ store: f.store, runtime: f.runtime, config }, 'test-clear', { confirm: true }), { code: 'test-clear-dsh-running' });
    assert.ok(f.store.session(sid));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('completed explicit messages recover into memory after a capture failure', async t => {
  const f = fixture(t, true); f.ingest(incoming('remember', 'recover')); await f.engine.submit(f.job('recover'));
  const j = f.job('recover'); f.runtime.emit(j.session, 'reply', '持久的发送记录'); await f.engine.flushEmissions();
  const completed = f.engine.cognitive.completed; f.engine.cognitive.completed = () => { throw Error('synthetic-storage-failure'); };
  for (const event of turn(j.request_id, 'private note')) await f.engine.onSession(j.session, event);
  f.engine.cognitive.completed = completed; await f.engine.cognitive.backfill(f.store);
  assert.ok(f.engine.cognitive.store.db.prepare('SELECT 1 FROM bridge_receipts WHERE job=?').get(j.id));
  assert.ok(f.engine.cognitive.store.db.prepare("SELECT 1 FROM raw_events WHERE source='assistant_narrative' AND text=?").get('持久的发送记录'));
});
test('Prompt and room inspection expose the chosen source without editing initial documents', async t => {
  const f = fixture(t); const data = await f.control('prompts', {});
  assert.equal(data.core, fs.readFileSync('SYS_Prompt.txt', 'utf8')); assert.ok(data.previousCore !== data.core);
  assert.equal(data.model.name, 'DeepSeek-V41-Flash');
  const room = await f.control('room-info', {}); assert.equal(room.location, path.join(f.dir, 'cognitive/room'));
});
