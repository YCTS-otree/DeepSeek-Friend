import fs from 'node:fs';
import path from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './util.js';
import { CognitiveStore } from './cognitive/store.js';
import { forget } from './cognitive/privacy.js';

export async function control({ store, runtime, config, engine }, action, args = {}) {
  if (!runtime && ['runtime-status', 'runtime-configure', 'runtime-stop', 'runtime-wake', 'thoughts', 'prompts', 'alarms', 'alarm-create', 'alarm-cancel', 'test-send', 'test-clear'].includes(action)) throw new BridgeError('interaction-disabled');
  if (action === 'room-info') { const test = typeof args.session === 'string' && store.session(args.session)?.kind === 'test'; const location = path.join(config.dataDir, ...(test ? ['testing'] : []), 'cognitive', 'room'); return { location, exists: fs.existsSync(location) }; }
  if (action === 'runtime-status') return { settings: runtime.settings(), contexts: runtime.db.prepare('SELECT * FROM contexts ORDER BY updated DESC LIMIT 30').all(),
    jobs: store.db.prepare("SELECT id,session,state,kind,error FROM jobs WHERE state IN ('queued','submitting','waiting','review') ORDER BY created LIMIT 30").all(),
    deliveries: store.db.prepare('SELECT id,state,error FROM outbox ORDER BY created DESC,rowid DESC LIMIT 30').all() };
  if (action === 'runtime-configure') return { settings: runtime.configure(args) };
  if (action === 'thoughts') return runtime.thoughts(args.session, args.before);
  if (action === 'prompts') return runtime.promptView(args.session, typeof args.session === 'string' ? store.session(args.session)?.kind : undefined);
  if (action === 'alarms') return { alarms: runtime.alarms(args.session) };
  if (action === 'alarm-cancel') return runtime.cancelAlarm(args.session, args.id);
  if (action === 'alarm-create') {
    if (!store.session(args.session)) throw new BridgeError('session-not-found');
    if (!runtime.context(args.session)) runtime.bind(args.session, 'local-alarm-planning', store.session(args.session).kind === 'test' ? 'test' : 'alarm');
    return runtime.alarm(args.session, 'local-' + randomUUID(), args.at, args.note);
  }
  if (action === 'runtime-stop') {
    if (!engine) throw new BridgeError('bridge-not-ready');
    const sessions = args.session ? [args.session] : store.db.prepare("SELECT DISTINCT session FROM jobs WHERE state IN ('submitting','waiting','review') AND session IS NOT NULL").all().map(r => r.session);
    for (const sid of sessions) {
      if (!store.session(sid)) throw new BridgeError('session-not-found');
      runtime.flag(sid, 'preempt'); runtime.flag(sid, 'rest');
      await engine.busy.get(sid);
      await engine.dsh.rpc('session/cancel', { sessionId: sid }, engine.signal);
      store.db.prepare("UPDATE jobs SET state='done',error='local-stop' WHERE session=? AND state IN ('queued','backoff','submitting','waiting','review')").run(sid);
      store.db.prepare("UPDATE pending SET state='stale' WHERE session=?").run(sid); engine.cognition(sid)?.idle(sid);
    }
    return { stopped: sessions };
  }
  if (action === 'test-send' || action === 'runtime-wake') {
    if (!engine) throw new BridgeError('bridge-not-ready');
    const s = store.session(args.session); if (!s || s.archived) throw new BridgeError('session-not-current');
    if (action === 'test-send' && s.kind !== 'test') throw new BridgeError('test-session-required');
    const text = action === 'runtime-wake' ? '【本机操作者唤醒】你可以继续自主思考或使用已授权工具，不要求对外输出。' : args.text;
    if (typeof text !== 'string' || !text.trim() || text.length > config.bridge.maxTextChars) throw new BridgeError('test-input-invalid');
    const id = randomUUID(), now = Date.now(), kind = action === 'runtime-wake' ? 'alarm' : 'test';
    store.tx(() => {
      store.db.prepare('INSERT INTO jobs(id,account,user,message_id,payload,request_id,state,session,created,updated,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, engine.account.accountId, engine.account.ownerId, id, JSON.stringify({ text, supported: true, ...(kind === 'alarm' ? { dshText: text } : {}) }), randomUUID(), 'queued', s.session, now, now, kind);
      store.chat('user:' + id, s.session, kind === 'test' ? 'user' : 'bridge', { displayName: 'OTREE（本机' + (kind === 'test' ? '测试' : '唤醒') + '）' }, text, now, id);
    });
    if (runtime.context(s.session)) runtime.flag(s.session, 'preempt');
    return { queued: id };
  }
  if (action === 'test-clear') {
    if (args.confirm !== true) throw new BridgeError('test-clear-confirm-required');
    if (engine?.testCognitive?.running) throw new BridgeError('test-worker-busy');
    if (!engine) {
      const url = new URL(config.dsh.baseUrl);
      const listening = await new Promise(resolve => { const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }); const finish = value => { socket.destroy(); resolve(value); }; socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(true)); });
      if (listening) throw new BridgeError('test-clear-dsh-running');
    }
    if (engine) engine.testMaintenance = true;
    try {
      await engine?.testBackfill;
      const sessions = store.db.prepare("SELECT session FROM chat_sessions WHERE kind='test'").all().map(r => r.session);
      for (const sid of sessions) {
        await engine?.busy.get(sid); if (engine && store.get('dsh-created:' + sid)) await engine.dsh.rpc('session/cancel', { sessionId: sid }, engine.signal);
        await engine?.chains.get(sid); engine?.dsh.unfollow(sid);
        engine?.testCognitive?.idle(sid);
      }
      store.tx(() => { for (const sid of sessions) { for (const table of ['chat_entries', 'events', 'pending', 'jobs']) store.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(sid);
        store.db.prepare('DELETE FROM chat_sessions WHERE session=? AND kind=?').run(sid, 'test'); } });
      for (const sid of sessions) runtime.clearTest(sid);
      const dir = path.join(config.dataDir, 'testing', 'cognitive');
      let cognitive = engine?.testCognitive?.store, opened = false;
      if (!cognitive && fs.existsSync(path.join(dir, 'cognitive.sqlite'))) { cognitive = new CognitiveStore(dir, config.cognitive); opened = true; }
      try { if (cognitive) for (const row of cognitive.db.prepare('SELECT id FROM scopes').all()) forget(cognitive, row.id); }
      finally { if (opened) cognitive.close(); }
      return { cleared: sessions.length, upstream: '已清空应用测试记录与测试记忆；DSH 原始运行日志未宣称物理删除。', ...store.sessionControl('list') };
    } finally { if (engine) engine.testMaintenance = false; }
  }
  if (engine && ['create', 'switch', 'archive'].includes(action) && [...engine.busy.keys()].some(sid => store.session(sid)?.kind === (args.kind ?? store.session(args.session)?.kind ?? 'conversation'))) throw new BridgeError('session-busy');
  const result = store.sessionControl(action, args);
  if (engine && ['create', 'switch'].includes(action)) engine.dsh.follow(result.session);
  return result;
}
