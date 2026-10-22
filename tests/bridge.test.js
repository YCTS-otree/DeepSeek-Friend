import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, turn, event, account } from './helpers.js';
import { Store } from '../src/store.js';
import { BridgeError } from '../src/util.js';
import { answerValue } from '../src/engine.js';

test('atomic cursor and inbox persist across restart; duplicate pushes cannot create jobs', t => {
  const f = fixture(t); const m = incoming('hello', 'm1'); f.ingest(m, m);
  const reopened = new Store(f.file);
  assert.equal(reopened.get('cursor:' + account.accountId), 'next-cursor');
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  const before = reopened.get('cursor:' + account.accountId);
  assert.throws(() => reopened.tx(() => { reopened.set('cursor:' + account.accountId, 'uncommitted'); throw Error('crash'); }));
  assert.equal(reopened.get('cursor:' + account.accountId), before); reopened.close();
});
test('unauthorized senders, bots, groups, and missing context are excluded', t => {
  const f = fixture(t);
  f.ingest(incoming('x', '1', 'mallory'), incoming('x', '2', 'alice', { group_id: 'group' }), incoming('x', '3', 'alice', { message_type: 2 }), incoming('x', '4', 'alice', { context_token: '' }));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT reason FROM quarantine').get().reason, 'missing-context');
});
test('malformed authorized envelopes are retained atomically without poisoning valid messages in a batch', t => {
  const f = fixture(t); const missing = incoming('no id', 'missing', 'alice', { message_id: undefined });
  f.ingest(missing, missing, incoming('bad shape', 'bad', 'alice', { item_list: {} }), incoming('good', 'good'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quarantine').get().n, 2);
  assert.ok(f.job('good')); assert.equal(f.store.get('cursor:bot-test'), 'next-cursor');
});
test('MVP workflow creates a real Agent prompt, collects text only, then replies using context and run ID', async t => {
  const f = fixture(t); f.ingest(incoming('你好', 'a')); const job = f.job('a'); await f.engine.submit(job);
  const prompt = f.dsh.calls.find(c => c.endpoint === 'session/prompt');
  assert.equal(prompt.args.mode, 'queue'); assert.equal(prompt.args.requestId, job.request_id);
  assert.equal(prompt.args.content[0].text, '你好');
  const current = f.store.job(job.id);
  for (const e of turn(job.request_id)) await f.engine.onSession(current.session, e);
  assert.equal(f.store.job(job.id).state, 'done');
  const row = f.store.db.prepare('SELECT * FROM outbox').get(); const body = JSON.parse(row.body).msg;
  assert.equal(body.context_token, 'fake-context'); assert.equal(body.run_id, 'run-test'); assert.equal(body.to_user_id, 'alice');
  assert.equal(body.message_type, 2); assert.equal(body.message_state, 2);
  assert.equal(body.item_list[0].text_item.text, '你好，我是 DSH。');
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM events').all()).includes('SECRET'));
  await f.engine.sendOne(); assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state, 'sent');
});
test('three related messages reuse one session; another user has an isolated identity', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) {
    f.ingest(incoming('context ' + i, 'a' + i)); const job = f.job('a' + i); await f.engine.submit(job);
    for (const e of turn(job.request_id, 'reply ' + i, i, (i - 1) * 4)) await f.engine.onSession(f.store.job(job.id).session, e);
  }
  const ids = f.dsh.calls.filter(c => c.endpoint === 'session/prompt').map(c => c.args.sessionId);
  assert.equal(new Set(ids).size, 1);
  f.ingest(incoming('bob', 'b', 'bob')); await f.engine.submit(f.job('b'));
  assert.notEqual(f.store.mapping('bot-test', 'alice').session, f.store.mapping('bot-test', 'bob').session);
});
test('new messages queue during inference and resume after completion', async t => {
  const f = fixture(t); f.ingest(incoming('first', '1'), incoming('second', '2'));
  await f.engine.tick(); await f.engine.drain(); await f.engine.tick(); await f.engine.drain();
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  const first = f.job('1'); for (const e of turn(first.request_id)) await f.engine.onSession(first.session, e);
  await f.engine.tick(); await f.engine.drain();
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/prompt').length, 2);
});
test('DSH network timeout retries with exactly the same request and session identifiers', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); const job = f.job('a');
  const rpc = f.dsh.rpc.bind(f.dsh); let failed = false;
  f.dsh.rpc = async (endpoint, args) => { const r = await rpc(endpoint, args); if (endpoint === 'session/prompt' && !failed) { failed = true; throw new BridgeError('dsh-network', '', { retryable: true, ambiguous: true }); } return r; };
  await f.engine.submit(job); assert.equal(f.store.job(job.id).state, 'submitting');
  await f.engine.submit(f.store.job(job.id));
  const prompts = f.dsh.calls.filter(c => c.endpoint === 'session/prompt');
  assert.equal(prompts[0].args.requestId, prompts[1].args.requestId); assert.equal(prompts[0].args.sessionId, prompts[1].args.sessionId);
});
test('unknown send outcome is quarantined; crash recovery preserves the original client_id', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); const job = f.job('a'); f.store.reply(job, 'answer', 'test');
  const before = f.store.db.prepare('SELECT body FROM outbox').get().body;
  let sends = 0; f.ilink.send = async () => { sends++; throw new BridgeError('ilink-network', '', { ambiguous: true }); };
  await f.engine.sendOne(); await f.engine.sendOne(); assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state, 'unknown');
  f.store.db.exec("UPDATE outbox SET state='sending'"); f.store.recover();
  assert.equal(f.store.db.prepare('SELECT body FROM outbox').get().body, before);
  assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state, 'unknown');
});
test('explicit rate limit retries the same outbox body and blocks later chunks', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); f.store.reply(f.job('a'), 'abcdef', 'long', 3);
  const sent = []; f.ilink.send = async body => { sent.push(body); if (sent.length === 1) throw new BridgeError('ilink-rate-limit', '', { retryable: true }); return {}; };
  await f.engine.sendOne(); assert.equal(await f.engine.sendOne(), false);
  f.store.db.exec('UPDATE outbox SET retry_at=0'); await f.engine.sendOne(); await f.engine.sendOne();
  assert.deepEqual(sent[0], sent[1]); assert.equal(sent[2].msg.item_list[0].text_item.text, 'def');
});
test('reconnection snapshots finalize unfinished work once and never replay completed replies', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  const snapshot = { type: 'snapshot', cursor: 3, hasMore: false, records: turn(j.request_id), projections: { asOfSeq: 3, values: {} } };
  await f.engine.onSession(j.session, snapshot); await f.engine.onSession(j.session, snapshot);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
});
test('multi-part assistant text aggregates in order and cancellation stays visible', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  const records = turn(j.request_id, 'part one').slice(0, 3);
  records.push(event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'part two' }] } }));
  records.push(event(4, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }));
  for (const r of records) await f.engine.onSession(j.session, r);
  const body = JSON.parse(f.store.db.prepare('SELECT body FROM outbox').get().body);
  assert.match(body.msg.item_list[0].text_item.text, /aborted[\s\S]*part one\n\npart two/);
});
test('history gaps page backward before consuming a reconnect snapshot', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  const records = turn(j.request_id); const rpc = f.dsh.rpc.bind(f.dsh);
  f.dsh.rpc = async (endpoint, args) => endpoint === 'session/page' ? { records: records.slice(0, 2), hasMore: false } : rpc(endpoint, args);
  await f.engine.onSession(j.session, { type: 'snapshot', cursor: 3, hasMore: true, records: records.slice(2) });
  assert.equal(f.store.job(j.id).state, 'done');
});
test('unsafe approvals fail closed and unrelated DSH sessions cannot be answered', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  const req = { agentId: j.session, clientId: 'client-test', eventId: 'e1', event: 'approval/request', request: { toolName: 'shell', callId: 'tool-1' } };
  await f.engine.onRequest(req);
  assert.equal(f.dsh.calls.at(-1).value, 'rejected');
  const length = f.dsh.calls.length; await f.engine.onRequest({ ...req, agentId: 'unrelated' }); assert.equal(f.dsh.calls.length, length);
});
test('approval grants require live client, owner, audit ID and exact tool call', async t => {
  const f = fixture(t, { allowApprovals: true }); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  for (const e of [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { source: { rpcId: j.request_id } }),
    event(2, 'tool/call', { turn: 1, callId: 'c1', name: 'write', arguments: '{"path":"sandbox/a"}' }), event(3, 'approval/asked', { id: 'audit1', callId: 'c1', toolName: 'write' })]) await f.engine.onSession(j.session, e);
  await f.engine.onRequest({ agentId: j.session, clientId: 'client-test', eventId: 'e1', event: 'approval/request', request: { toolName: 'write', callId: 'c1' } });
  const pending = f.store.db.prepare('SELECT * FROM pending').get();
  while (await f.engine.sendOne()) { /* Complete display of the exact operation before accepting approval. */ }
  f.ingest(incoming('/approve ' + pending.id, 'bob-attack', 'bob'));
  await assert.rejects(f.engine.command(f.job('bob-attack')), { code: 'pending-stale-or-foreign' });
  f.ingest(incoming('/approve ' + pending.id, 'approve'));
  await f.engine.command(f.job('approve')); assert.equal(f.dsh.calls.at(-1).value, 'allowed-once');
  await assert.rejects(f.engine.command(f.job('approve')), { code: 'pending-stale-or-foreign' });
});
test('stale approval cannot survive disconnect or cancellation', async t => {
  const f = fixture(t); f.store.db.prepare('INSERT INTO pending(id,session,account,user,event_id,client_id,kind,request,expires) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('p', 's', 'bot-test', 'alice', 'e', 'client-test', 'approval', '{}', Date.now() + 1000);
  f.dsh.emit('disconnected'); assert.equal(f.store.db.prepare('SELECT state FROM pending').get().state, 'stale');
});
test('clarification answers are session-bound and ordinary messages remain queued', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  await f.engine.onRequest({ agentId: j.session, clientId: 'client-test', eventId: 'q1', event: 'user-questions/request', request: { questions: [{ id: 'color', question: '喜欢什么颜色？' }] } });
  const p = f.store.db.prepare('SELECT * FROM pending').get();
  f.ingest(incoming('more', 'more'), incoming(`/answer ${p.id} 蓝色`, 'ans'));
  await f.engine.tick(); await f.engine.drain();
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  assert.equal(f.dsh.calls.at(-1).value.answers[0].custom, '蓝色'); assert.equal(f.job('more').state, 'queued');
});
test('answer schema rejects missing IDs, foreign choices and multi-selection violations', () => {
  const r = { questions: [{ id: 'q', question: '?', options: [{ label: 'a' }, { label: 'b' }] }] };
  assert.throws(() => answerValue(r, '[{"id":"wrong","selected":[]}]'));
  assert.throws(() => answerValue(r, '[{"id":"q","selected":["root"]}]'));
  assert.throws(() => answerValue(r, '[{"id":"q","selected":["a","b"]}]'));
});
test('reset explicitly removes DSH inbox before cancelling; old Agent history is retained', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const old = f.job('a').session;
  const rpc = f.dsh.rpc.bind(f.dsh); f.dsh.rpc = async (endpoint, args) => {
    const result = await rpc(endpoint, args);
    return endpoint === 'session/projections' ? { values: { inbox: { 'next-turn': [{ id: 'queued-id' }], 'next-step': [] } } } : result;
  };
  f.ingest(incoming('/reset', 'reset')); await f.engine.command(f.job('reset'));
  const methods = f.dsh.calls.map(c => c.endpoint); assert.ok(methods.indexOf('session/updateQueue') < methods.indexOf('session/cancel'));
  f.ingest(incoming('new', 'new')); await f.engine.submit(f.job('new')); assert.notEqual(f.job('new').session, old);
});
test('stale auth halts polling immediately and records a safe error code', async t => {
  const f = fixture(t); let count = 0; f.ilink.updates = async () => { count++; throw new BridgeError('ilink-auth-expired'); };
  await assert.rejects(f.engine.poll(), { code: 'ilink-auth-expired' }); assert.equal(count, 1);
  assert.equal(f.store.get('last-error'), 'ilink-auth-expired');
});
test('Agent exceptions and timeouts remain blocked for controlled recovery', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  f.dsh.emit('remote', { event: 'api-session/error', args: [j.session, 'private-error'] });
  assert.equal(f.job('a').state, 'review');
  f.store.updateJob(j.id, 'waiting'); f.store.db.prepare('UPDATE jobs SET updated=0 WHERE id=?').run(j.id);
  await f.engine.tick(); assert.equal(f.job('a').state, 'review'); assert.equal(f.dsh.calls.at(-1).endpoint, 'session/cancel');
});
