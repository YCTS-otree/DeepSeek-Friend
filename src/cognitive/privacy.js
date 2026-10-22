import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../util.js';
import { SELF_FIELDS, SHARED_SCOPE } from './store.js';

function scopeId(scope) { if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) throw new BridgeError('cognitive-scope-id'); }
function removeProjection(store, scope) {
  scopeId(scope); if (scope !== SHARED_SCOPE) throw new BridgeError('cognitive-scope-id');
  const target = path.join(store.dir, 'self'); if (!fs.existsSync(target)) return;
  const actual = fs.realpathSync(target); const parent = fs.realpathSync(store.dir);
  if (fs.lstatSync(target).isSymbolicLink() || !actual.startsWith(parent + path.sep) || path.basename(actual) !== 'self') throw new BridgeError('cognitive-projection-path');
  fs.rmSync(actual, { recursive: true });
}
export function exportScope(store, scope) {
  scopeId(scope); store.current(scope);
  const data = { format: 'DSFriend-cognitive-v1', scope };
  for (const table of ['scopes', 'bindings', 'raw_events', 'memories', 'edges', 'self_versions', 'diaries', 'goals']) {
    data[table] = store.db.prepare(`SELECT * FROM ${table} WHERE ${table === 'scopes' ? 'id' : 'scope'}=?`).all(scope);
  }
  return data;
}
export function archiveMemory(store, scope, id) {
  store.evidence(scope, [id], 'memories');
  store.db.prepare('UPDATE memories SET active=0 WHERE scope=? AND id=?').run(scope, id);
  store.mirror(scope); return { archived: id };
}
export function forget(store, scope, { eventId = null } = {}) {
  scopeId(scope); store.current(scope);
  store.db.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS suppressed_sessions(session TEXT PRIMARY KEY,scope TEXT NOT NULL);');
  const affected = eventId ? store.evidence(scope, [eventId]) : store.db.prepare('SELECT * FROM raw_events WHERE scope=?').all(scope);
  const roots = new Set(affected.map(e => e.root));
  const rows = store.db.prepare('SELECT * FROM raw_events WHERE scope=?').all(scope).filter(r => !eventId || roots.has(r.root));
  const deletedEvents = new Set(rows.map(r => r.id)); const sessions = [...new Set(rows.map(r => r.session))];
  const memories = store.db.prepare('SELECT * FROM memories WHERE scope=?').all(scope);
  const deletedMemories = new Set(memories.filter(m => !eventId || JSON.parse(m.evidence).some(e => deletedEvents.has(e.id))).map(m => m.id));
  store.tx(() => {
    for (const sid of sessions) store.db.prepare('INSERT OR REPLACE INTO suppressed_sessions VALUES(?,?)').run(sid, scope);
    if (!eventId) {
      store.db.prepare('DELETE FROM edges WHERE scope=?').run(scope);
      store.db.prepare('DELETE FROM scopes WHERE id=?').run(scope);
      store.db.prepare('DELETE FROM bridge_receipts WHERE scope=?').run(scope);
    } else {
      for (const id of deletedEvents) store.db.prepare('DELETE FROM raw_events WHERE scope=? AND id=?').run(scope, id);
      for (const id of deletedMemories) {
        store.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(scope, id);
        store.db.prepare('DELETE FROM edges WHERE scope=? AND (src=? OR dst=?)').run(scope, id, id);
      }
      // Free-form derived prose may repeat deleted data without a perfect citation; conservatively clear it.
      for (const table of ['proposals', 'tasks', 'diaries', 'goals']) store.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
      for (const version of store.db.prepare('SELECT * FROM self_versions WHERE scope=?').all(scope)) {
        const model = JSON.parse(version.model);
        for (const field of SELF_FIELDS) model[field] = model[field].filter(item => !item.evidenceRefs.some(id => deletedMemories.has(id)));
        store.db.prepare('UPDATE self_versions SET model=?,change_summary=?,evidence_refs=? WHERE scope=? AND version=?')
          .run(JSON.stringify(model), '用户删除后清理的历史版本（旧摘要已移除）', JSON.stringify(JSON.parse(version.evidence_refs).filter(id => !deletedMemories.has(id))), scope, version.version);
      }
      for (const session of sessions) store.db.prepare('DELETE FROM bindings WHERE scope=? AND session=?').run(scope, session);
    }
  });
  removeProjection(store, scope); if (eventId) store.mirror(scope);
  // Remove this application's own prior exports too; external copies/backups remain the operator's responsibility.
  const exports = path.join(store.dir, 'exports');
  if (fs.existsSync(exports)) {
    if (fs.lstatSync(exports).isSymbolicLink() || !fs.realpathSync(exports).startsWith(fs.realpathSync(store.dir) + path.sep)) throw new BridgeError('cognitive-export-path');
    for (const name of fs.readdirSync(exports)) if (name.startsWith(scope + '-') && name.endsWith('.json')) fs.rmSync(path.join(exports, name));
  }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  return { scope, deletedEvents: deletedEvents.size, deletedMemories: deletedMemories.size, sessions,
    upstreamHistory: 'DSH 原始日志与提供方/用户备份未被此认知存储删除；旧会话已标记不再用于认知访问。' };
}
export function cleanBridgeHistory(bridge, scope, sessions, { all = true } = {}) {
  // The Agent owns one shared memory space. An explicit full wipe affects all participants; an event wipe affects its sessions.
  if (scope !== SHARED_SCOPE) throw new BridgeError('cognitive-scope-id');
  const mappings = bridge.db.prepare('SELECT * FROM conversations').all().filter(m => all || sessions.includes(m.session));
  bridge.db.exec('PRAGMA secure_delete=ON');
  bridge.tx(() => {
    for (const m of mappings) {
      if (!sessions.includes(m.session)) sessions.push(m.session);
      bridge.db.prepare('DELETE FROM conversations WHERE account=? AND user=?').run(m.account, m.user);
      for (const table of ['jobs', 'outbox', 'pending']) bridge.db.prepare(`DELETE FROM ${table} WHERE account=? AND user=?`).run(m.account, m.user);
    }
    for (const sid of sessions) bridge.db.prepare('DELETE FROM events WHERE session=?').run(sid);
  });
  bridge.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
}
