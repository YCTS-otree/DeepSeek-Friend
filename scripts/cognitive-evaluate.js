import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { loadCredentials } from '../src/security.js';
import { CognitiveStore } from '../src/cognitive/store.js';
import { CognitiveService } from '../src/cognitive/service.js';
import { DshClient } from '../src/dsh.js';

// Optional research run: model-driven consolidation/reflection over synthetic days, not a real longitudinal study.
const at = process.argv.indexOf('--days'); const days = at < 0 ? 3 : Number(process.argv[at + 1]);
if (!Number.isInteger(days) || days < 1 || days > 14) throw Error('days must be 1..14');
if (!process.env.COGNITIVE_LIVE_CONFIG) throw Error('Run through npm run cognitive:eval');
const c = loadConfig(process.env.COGNITIVE_LIVE_CONFIG);
if (!c.dataDir.includes('.research') || new URL(c.dsh.baseUrl).port !== '3098') throw Error('evaluation requires isolated test runtime');
const saved = loadCredentials(c.dataDir, 'dsh-connection.json'); const dsh = new DshClient({ ...c.dsh, cookie: saved.cookie });
const ac = new AbortController(); const ready = once(dsh, 'connected'); const running = dsh.run(ac.signal); await ready;
const report = { synthetic: true, realModel: true, days, disclaimer: '合成来源和模拟日期；并非实际数日生活或已证实的人格/意识。no-op 合法，版本增多不视为更好。', agents: [] };
try {
  for (const [tag, method] of [['A', '先建立可复现的回归测试再修改'], ['B', '先澄清用户验收条件再实施']]) {
    const dir = path.join(c.dataDir, 'evaluation-' + tag); const store = new CognitiveStore(dir, c.cognitive);
    let now = Date.UTC(2026, 9, 22, 0); const service = new CognitiveService(c, dsh, { accountId: 'synthetic-' + tag, ownerId: 'OTREE-test' }, ac.signal, { store, now: () => now });
    service.schedule = () => {}; // Synthetic snapshots below; execution uses the production retry state machine.
    const scope = store.scope(); const before = store.current(scope); const turns = [];
    try {
      for (let day = 0; day < days; day++) {
        now += 86400000;
        const session = 'synthetic-' + tag + '-' + day; const text = `【合成测试数据，非真实经历】第 ${day + 1} 个独立任务中，${method}，避免了需求 ${day + 1} 的返工；本条是评测提供的用户反馈。`;
        const user = store.record(scope, { session, seq: 'feedback', root: session, source: 'user_statement', text, at: now, actor: { displayName: 'OTREE（合成评测）' } });
        const result = store.record(scope, { session, seq: 'result', root: session, source: 'tool_result',
          text: JSON.stringify({ synthetic: true, toolName: 'evaluation_fixture', message: { isError: false, content: [{ type: 'text', text: `合成验收结果：任务 ${day + 1} 达到对应验收项；采用方法：${method}` }] } }), at: now });
        const rows = store.evidence(scope, [user, result]); const clock = 'synthetic-day-' + String(day + 1);
        for (const kind of ['daily', 'dream']) {
          const id = service.createTask(scope, kind, clock, rows, Math.max(...rows.map(r => r.n)));
          const task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
          for (let attempt = 0; attempt < c.cognitive.maxAttempts; attempt++) {
            store.db.prepare('UPDATE tasks SET retry_at=0 WHERE id=?').run(id);
            await service.tick(); if (service.running) await service.running;
            if (['done', 'failed'].includes(store.db.prepare('SELECT state FROM tasks WHERE id=?').get(id).state)) break;
          }
          const outcome = store.db.prepare('SELECT state,result,error,attempts FROM tasks WHERE id=?').get(id);
          turns.push({ day: day + 1, kind, accepted: outcome.state === 'done', attempts: outcome.attempts, version: store.current(scope).version,
            ...(outcome.result ? { selfValidation: JSON.parse(outcome.result).validation.self } : { code: outcome.error }) });
        }
      }
      report.agents.push({ tag, suppliedHistory: method, initialEmptyTraits: before.model.traits.length === 0,
        self: store.visibleSelf(scope), memoryCount: store.db.prepare('SELECT count(*) AS n FROM memories').get().n,
        receipts: turns, history: store.history(scope) });
    } finally { store.close(); }
  }
  const file = path.join(c.dataDir, 'longitudinal-evaluation.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ file, syntheticDays: days, agents: report.agents.map(a => ({ tag: a.tag, version: a.self.version, memoryCount: a.memoryCount,
    acceptedTasks: a.receipts.filter(r => r.accepted).length, rejectedTasks: a.receipts.filter(r => !r.accepted).length })) }));
} finally { ac.abort(); await running; }
