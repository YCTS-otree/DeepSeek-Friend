import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { loadCredentials } from '../src/security.js';
import { DshClient } from '../src/dsh.js';
import { CognitiveStore } from '../src/cognitive/store.js';
import { CognitiveService } from '../src/cognitive/service.js';

test('REAL DSH/model: Core + shared Self hot-update on one existing Session and isolated background JSON turn',
  { skip: process.env.RUN_COGNITIVE_LIVE !== '1', timeout: 180000 }, async () => {
    const c = loadConfig(process.env.COGNITIVE_LIVE_CONFIG);
    if (!c.dataDir.includes('.research') || new URL(c.dsh.baseUrl).port !== '3098') throw new Error('live-test-must-use-isolated-research-state-and-port');
    const credential = loadCredentials(c.dataDir, 'dsh-connection.json');
    const client = new DshClient({ ...c.dsh, cookie: credential.cookie }); const abort = new AbortController();
    const store = new CognitiveStore(path.join(c.dataDir, 'cognitive'), c.cognitive);
    const scope = store.scope('TEST-ONLY', 'synthetic-evidence'); const session = 'cognitive-live-' + randomUUID();
    store.bind(scope, session, '认知兼容性测试', 'conversation', { displayName: 'OTREE（兼容测试）' });
    let running;
    async function runTurn(text) {
      const requestId = randomUUID(); const records = new Map();
      let receive; let timer;
      const done = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('real-turn-timeout')), 75000);
        receive = (sid, frame) => {
          if (sid !== session) return;
          for (const r of frame.type === 'snapshot' ? frame.records ?? [] : frame.type === 'event' ? [frame] : []) records.set(r.event.seq, r.event);
          const events = [...records.values()].sort((a, b) => a.seq - b.seq);
          const user = events.find(e => e.type === 'user/message' && e.data.source?.rpcId === requestId); if (!user) return;
          const start = events.filter(e => e.type === 'turn/start' && e.seq < user.seq).at(-1);
          const end = events.find(e => e.type === 'turn/end' && e.data.turn === start?.data.turn && e.seq > user.seq);
          if (end) { clearTimeout(timer); end.data.reason?.kind === 'completed' ? resolve(events) : reject(new Error('real-turn-incomplete')); }
        };
        client.on('session', receive);
      });
      done.catch(() => {});
      try { await client.rpc('session/prompt', { sessionId: session, requestId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' }); return await done; }
      finally { clearTimeout(timer); client.off('session', receive); }
    }
    try {
      await client.check(); const ready = once(client, 'connected'); running = client.run(abort.signal); await ready;
      await client.rpc('session/create', { sessionId: session, cwd: c.dsh.cwd, agentPreset: 'weixin' }); client.follow(session);
      const first = await runTurn('这是接口兼容性测试，不要调用工具。只回复 OK。');
      const system = first.filter(e => e.type === 'system/message').map(e => JSON.stringify(e.data)).join('\n');
      assert.match(system, /快乐的小鲸鱼/); assert.match(system, /Evolving Self/); assert.match(system, /OTREE/);
      const id = store.record(scope, { session, seq: 'synthetic-fixture', root: 'synthetic-fixture', source: 'user_statement', text: '仅用于兼容测试的证据：下一轮应看到新的自我模型版本。', actor: { displayName: 'OTREE（合成测试数据）' } });
      const m = store.remember(scope, { kind: 'episodic', source: 'user_statement', text: '合成测试记录：检查同一会话下一轮装配的新版本。', evidence: [{ id, quote: '下一轮应看到新的自我模型版本' }] });
      const p = store.propose(scope, { baseVersion: store.current(scope).version, changes: { understanding: [{ text: 'LIVE_HOT_UPDATE_MARKER：这是合成测试数据，不是实际人格结论。', evidenceRefs: [m], confidence: 'tentative' }] }, summary: '实际 DSH 热装配测试' });
      store.commit(scope, p.id);
      const catalog = await client.rpc('session/modelCatalog');
      const alternate = catalog.groups.flatMap(g => g.models.map(m => ({ provider: g.id, model: m.id })))
        .find(m => m.provider === catalog.default.provider && m.model !== catalog.default.model);
      if (alternate) {
        const switched = await client.rpc('session/selectModel', { sessionId: session, ...alternate });
        assert.equal(switched.selected.model, alternate.model);
      }
      console.log(JSON.stringify({ cognitiveLiveModelSwitch: Boolean(alternate) }));
      const second = await runTurn('继续兼容性测试，不要调用工具。只回复 OK。');
      assert.match(second.filter(e => e.type === 'system/message').map(e => JSON.stringify(e.data)).join('\n'), /LIVE_HOT_UPDATE_MARKER/);
      const svc = new CognitiveService(c, client, { accountId: 'TEST-ONLY', ownerId: 'synthetic-evidence' }, abort.signal, { store });
      const rows = store.db.prepare('SELECT * FROM raw_events WHERE scope=? ORDER BY n').all(scope);
      const taskId = svc.createTask(scope, 'daily', '2026-10-22', rows, rows.at(-1).n); const task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      store.bind(scope, task.session, '', 'worker');
      const result = await svc.worker(task);
      assert.ok(result && typeof result === 'object'); assert.ok(Array.isArray(result.memories));
      svc.applyResult(task, result); assert.equal(store.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id).state, 'done');
      assert.notEqual(task.session, session); assert.equal(store.binding(session).scope, scope);
    } finally { abort.abort(); await client.rpc('session/cancel', { sessionId: session }).catch(() => {}); if (running) await running; store.close(); }
  });
