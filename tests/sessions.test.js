import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, incoming, turn } from './helpers.js';
import { Store } from '../src/store.js';
import { CognitiveStore } from '../src/cognitive/store.js';
import { initialPortrait } from '../src/cognitive/bootstrap.js';
import { Room } from '../src/cognitive/room.js';
import { forget } from '../src/cognitive/privacy.js';

async function exchange(f, id, user = 'alice') {
  f.ingest(incoming('question-' + id, id, user)); await f.engine.submit(f.job(id));
  const job = f.job(id), base = f.store.session(job.session).cursor + 1;
  for (const e of turn(job.request_id, 'answer-' + id, base + 1, base)) await f.engine.onSession(job.session, e);
  while (await f.engine.sendOne()) { /* drain confirmed mock sends */ }
  return job.session;
}
test('only explicit WebUI creation/switch changes the one selected session, with archived history', async t => {
  const f = fixture(t); const first = await exchange(f, 'one');
  assert.equal(await exchange(f, 'two', 'bob'), first);
  const next = f.store.sessionControl('create', { title: '第二次对话' }).session;
  assert.notEqual(next, first); assert.equal(f.store.session(first).archived, 1);
  assert.equal(await exchange(f, 'three'), next);
  const history = f.store.sessionControl('history', { session: first }).entries;
  assert.deepEqual(history.map(e => [e.role, e.text]), [['user', 'question-one'], ['assistant', 'answer-one'], ['user', 'question-two'], ['assistant', 'answer-two']]);
  assert.ok(!JSON.stringify(history).includes('SECRET'));
  f.store.sessionControl('switch', { session: first });
  assert.equal(await exchange(f, 'four'), first);
  assert.equal(f.store.session(next).archived, 1);
  assert.throws(() => f.store.db.prepare('DELETE FROM chat_sessions WHERE session=?').run(next), /archived-not-deleted/);
  assert.throws(() => f.store.sessionControl('delete', { session: first }), { code: 'session-action-invalid' });
});
test('queued messages, unresolved sends and approval waits prevent switching; no request moves', async t => {
  const f = fixture(t); f.ingest(incoming('pending', 'p'));
  const sid = f.job('p').session;
  assert.throws(() => f.store.sessionControl('create'), { code: 'session-busy' });
  await f.engine.submit(f.job('p')); assert.equal(f.job('p').session, sid);
  for (const e of turn(f.job('p').request_id)) await f.engine.onSession(sid, e);
  f.store.db.exec("UPDATE outbox SET state='unknown'");
  assert.throws(() => f.store.sessionControl('create'), { code: 'session-busy' });
  f.store.db.exec("UPDATE outbox SET state='sent'");
  f.store.db.prepare('INSERT INTO pending(id,session,account,user,event_id,client_id,kind,request,expires) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('test-wait', sid, 'bot-test', 'alice', 'event', 'client', 'approval', '{}', Date.now() + 10000);
  assert.throws(() => f.store.sessionControl('create'), { code: 'session-busy' });
  assert.equal(f.store.currentSession().session, sid);
});
test('one shared session serializes different senders and approvals stay with the actual requesting user', async t => {
  const f = fixture(t); f.ingest(incoming('first', 'a'), incoming('second', 'b', 'bob'));
  await f.engine.tick(); await f.engine.drain();
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  const first = f.job('a'); for (const e of turn(first.request_id)) await f.engine.onSession(first.session, e);
  await f.engine.tick(); await f.engine.drain();
  await f.engine.onRequest({ agentId: first.session, event: 'user-questions/request', clientId: f.dsh.clientId, eventId: 'bob-question', request: { questions: [{ id: 'q', question: '需要什么？' }] } });
  assert.equal(f.store.db.prepare('SELECT user FROM pending').get().user, 'bob');
  assert.equal(f.job('a').session, f.job('b').session);
});
test('restart and duplicated DSH snapshots preserve both sides exactly once in the local transcript', async t => {
  const f = fixture(t); const sid = await exchange(f, 'saved');
  const reopened = new Store(f.file);
  try { assert.equal(reopened.currentSession().session, sid); assert.equal(reopened.sessionControl('history', { session: sid }).entries.length, 2); }
  finally { reopened.close(); }
  for (const e of turn(f.job('saved').request_id, 'answer-saved')) await f.engine.onSession(sid, e);
  assert.equal(f.store.sessionControl('history', { session: sid }).entries.length, 2);
});
test('a vanished established DSH Session is never silently recreated or replaced', async t => {
  const f = fixture(t); const sid = await exchange(f, 'existing');
  const before = f.dsh.calls.filter(c => c.endpoint === 'session/create').length;
  const rpc = f.dsh.rpc.bind(f.dsh); f.dsh.rpc = async (endpoint, args) => {
    if (endpoint === 'session/projections') throw Object.assign(Error(), { code: 'session/not-found' });
    return rpc(endpoint, args);
  };
  f.ingest(incoming('continue', 'missing')); await f.engine.submit(f.job('missing'));
  assert.equal(f.job('missing').state, 'review'); assert.equal(f.store.currentSession().session, sid);
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/create').length, before);
});
test('history paginates by persistent sequence without reading tokens or reasoning', t => {
  const f = fixture(t); const sid = f.store.ensureMapping('a', 'u').session;
  for (let i = 0; i < 130; i++) f.store.chat('test-' + i, sid, i % 2 ? 'assistant' : 'user', {}, 'text-' + i);
  const page = f.store.sessionControl('history', { session: sid });
  assert.equal(page.entries.length, 100); assert.equal(page.hasMore, true);
  const older = f.store.sessionControl('history', { session: sid, before: page.entries[0].n });
  assert.equal(older.entries.length, 30); assert.equal(older.hasMore, false);
});
test('legacy mappings are migrated without deleting sessions or changing admitted requests', t => {
  const f = fixture(t); const old = randomUUID(), other = randomUUID();
  f.store.db.prepare('INSERT INTO conversations(account,user,session,cursor) VALUES(?,?,?,?)').run('bot-test', 'alice', old, 42);
  f.store.db.prepare('INSERT INTO conversations(account,user,session,cursor) VALUES(?,?,?,?)').run('bot-test', 'bob', other, 7);
  f.store.db.exec("DELETE FROM meta WHERE key IN ('managed-sessions','chat-history-imported')");
  const next = new Store(f.file);
  try { assert.equal(next.currentSession().session, old); assert.equal(next.session(old).cursor, 42); assert.equal(next.session(other).archived, 1); }
  finally { next.close(); }
});
test('v0.1.0 remains byte-identical through Self evolution, no-op, rollback and memory deletion', t => {
  const dir = path.resolve('.research/seed-tests', randomUUID()); const store = new CognitiveStore(dir); t.after(() => store.close());
  const scope = store.scope(), source = fs.readFileSync('Self_model.txt'), file = path.join(dir, 'historical/v0.1.0/SELF_MODEL.md');
  assert.ok(fs.readFileSync(file).equals(source));
  assert.equal(store.current(scope).model.selfPortrait[0].text, source.toString('utf8'));
  const raw = store.record(scope, { session: 's', seq: 1, root: 'r', source: 'user_statement', text: 'OTREE 反馈：新的工作方式更加自然。' });
  const mem = store.remember(scope, { kind: 'reflective', source: 'user_statement', text: '工作方式收到反馈', evidence: [{ id: raw, quote: '更加自然' }] });
  const p = store.propose(scope, { baseVersion: 1, summary: '依据反馈调整自述', changes: { selfPortrait: [{ text: '我还在探索自然的协作方式。', evidenceRefs: [mem], confidence: 'tentative' }] } });
  store.commit(scope, p.id); assert.notEqual(store.current(scope).model.selfPortrait[0].text, initialPortrait().text);
  store.rollback(scope, 1, '回顾起点');
  assert.ok(fs.readFileSync(file).equals(source));
  forget(store, scope); assert.ok(fs.readFileSync(file).equals(source));
});
test('SYS Prompt replaces the previous core byte for byte and the original core remains backed up', () => {
  const current = fs.readFileSync('cognitive/CORE.md'), supplied = fs.readFileSync('SYS_Prompt.txt');
  assert.ok(current.equals(supplied));
  const previous = fs.readFileSync('cognitive/bootstrap/pre-1.3.0/CORE.md');
  assert.ok(!previous.equals(current));
  const manifest = JSON.parse(fs.readFileSync('cognitive/bootstrap/pre-1.3.0/manifest.json', 'utf8'));
  assert.equal(createHash('sha256').update(previous).digest('hex'), manifest.sha256);
  assert.equal(manifest.mode, 'replace-not-append');
});
test('the little room persists independently from Self/Session and requires version checks on writes', t => {
  const dir = path.resolve('.research/room-tests', randomUUID()); const room = new Room(dir);
  const written = room.write('notes/今天.md', '一次真实的测试笔记。');
  assert.equal(room.read('notes/今天.md').text, '一次真实的测试笔记。');
  assert.throws(() => room.write('notes/今天.md', 'blind overwrite'), { code: 'room-version-conflict' });
  room.write('notes/今天.md', '修订后的笔记', written.sha256);
  assert.equal(new Room(dir).read('notes/今天.md').text, '修订后的笔记');
  for (const name of ['../escape.txt', 'C:/escape.txt', 'a/../../escape.md', 'secret.txt', 'credentials.json', 'folder\\escape.txt', 'CON.txt']) assert.throws(() => room.write(name, 'x'));
  assert.throws(() => room.write('large.txt', 'a'.repeat(65537)));
  assert.ok(room.list().files.some(f => f.path === 'ROOM.md'));
  assert.equal(written.sha256, createHash('sha256').update('一次真实的测试笔记。').digest('hex'));
});
