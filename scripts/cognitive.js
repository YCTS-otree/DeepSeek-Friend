import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { secureDirectory } from '../src/security.js';
import { dataLock } from '../src/lock.js';
import { Store } from '../src/store.js';
import { CognitiveStore } from '../src/cognitive/store.js';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { exportScope, archiveMemory, forget, cleanBridgeHistory } from '../src/cognitive/privacy.js';

const [command = 'help', scope, value] = process.argv.slice(2);
if (command === 'help') {
  console.log('本地认知维护：先在 Web UI 停止服务（Bridge 与独立 DSH）。\nstatus | self <scope> | history <scope> | query <scope> <text> | trace <scope> <memoryId> | raw <scope> <text>\nexport <scope> | archive <scope> <memoryId> | rollback <scope> <version>\ncorrect <scope> <memoryId>（标准输入 JSON：{"text":"更正内容"}）\nforget-event <scope> <eventId> --confirm | forget-scope <scope> --confirm | retry <scope> <taskId>');
} else {
  let release; let store;
  try {
    const c = loadConfig(); secureDirectory(c.dataDir); release = dataLock(c.dataDir);
    store = new CognitiveStore(path.join(c.dataDir, 'cognitive'), c.cognitive);
    store.db.exec('CREATE TABLE IF NOT EXISTS bridge_receipts(job TEXT PRIMARY KEY,scope TEXT NOT NULL);');
    let result;
    if (command === 'status') result = { scopes: store.db.prepare('SELECT * FROM scopes').all(), tasks: store.db.prepare('SELECT id,scope,kind,day,state,attempts,error FROM tasks ORDER BY created DESC LIMIT 30').all() };
    else if (command === 'self') result = store.visibleSelf(scope);
    else if (command === 'history') result = store.history(scope);
    else if (command === 'query') result = store.retrieve(scope, value ?? '');
    else if (command === 'trace') result = store.trace(scope, value);
    else if (command === 'raw') result = store.rawSearch(scope, value ?? '');
    else if (command === 'correct') {
      const old = store.trace(scope, value); const text = JSON.parse(fs.readFileSync(0, 'utf8')).text;
      const source = randomUUID();
      result = store.tx(() => {
        const id = store.record(scope, { session: 'local-correction', seq: source, root: source, source: 'user_statement', text,
          actor: { displayName: '本地操作者（明确更正）' } });
        return { corrected: store.remember(scope, { kind: old.kind, text, source: 'user_statement', evidence: [{ id, quote: text }], supersedes: [value] }) };
      });
      store.mirror(scope);
    }
    else if (command === 'archive') result = archiveMemory(store, scope, value);
    else if (command === 'rollback') result = store.rollback(scope, Number(value), '本地操作者请求');
    else if (command === 'export') {
      const data = exportScope(store, scope); const dir = path.join(store.dir, 'exports'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, scope + '-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); result = { file, private: true };
    } else if (['forget-event', 'forget-scope'].includes(command)) {
      if (!process.argv.includes('--confirm')) throw new Error('cognitive-confirm-required');
      const url = new URL(c.dsh.baseUrl);
      const active = await new Promise(resolve => { const socket = net.connect({ host: url.hostname, port: Number(url.port) });
        socket.setTimeout(1000); socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
      if (active) throw new Error('cognitive-stop-dsh-before-delete');
      result = forget(store, scope, { eventId: command === 'forget-event' ? value : null });
      const file = path.join(c.dataDir, 'bridge.sqlite');
      if (fs.existsSync(file)) { const bridge = new Store(file); try { cleanBridgeHistory(bridge, scope, result.sessions, { all: command === 'forget-scope' }); } finally { bridge.close(); } }
    } else if (command === 'retry') {
      const changed = store.db.prepare("UPDATE tasks SET state='retry',attempts=0,retry_at=0,error=NULL WHERE scope=? AND id=? AND state='failed'").run(scope, value).changes;
      result = { changed };
    } else throw new Error('cognitive-command-unknown');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = typeof error.code === 'string' && /^[a-z0-9-]+$/.test(error.code) ? error.code : /^cognitive-[a-z-]+$/.test(error.message ?? '') ? error.message : 'cognitive-maintenance-failed';
    console.error(JSON.stringify({ code })); process.exitCode = 1;
  } finally { store?.close(); release?.(); }
}
