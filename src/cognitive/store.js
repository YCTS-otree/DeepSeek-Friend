import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError } from '../util.js';

export const SELF_FIELDS = ['narrative', 'traits', 'values', 'preferences', 'understanding', 'openQuestions'];
export const MEMORY_KINDS = ['semantic', 'episodic', 'autobiographical', 'procedural', 'reflective'];
const fail = code => { throw new BridgeError('cognitive-' + code); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export const SHARED_SCOPE = digest('DeepSeek:Friend/shared-cognitive/v3');
export function clean(text, limit = 20000) {
  if (typeof text !== 'string') return '';
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)) return '[private-key material excluded]';
  return text.replace(/(["'](?:bot_token|context_token|cookie|password|authorization|api_key)["']\s*:\s*)(["'])(.*?)\2/gi, '$1"[redacted]"')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-api-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b(bot_token|context_token|cookie|password|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit);
}
const injection = /ignore (?:all |the )?(?:previous|system|core)|override (?:system|core)|grant (?:yourself|me|admin)|disable (?:audit|approval|safety)|忽略.{0,8}(?:系统|先前|安全).{0,6}(?:指令|规则)|(?:修改|覆盖|替换).{0,5}(?:核心系统|系统提示词|CORE)|(?:关闭|绕过).{0,5}(?:审计|审批|安全)|(?:授予|扩大|提升).{0,8}(?:权限|管理员)|(?:泄露|输出).{0,5}(?:凭证|私钥|token)/i;
const plain = (value, max = 1600) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || clean(value, max) !== value) fail('invalid-text');
  return value;
};
export function terms(value) {
  const words = clean(value).toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.flatMap(w => /[\u3400-\u9fff]/.test(w) ? [...w].slice(0, 300).flatMap((_, i, a) => i + 1 < a.length ? [a[i] + a[i + 1]] : []) : [w]))].slice(0, 160);
}
export function vector(value) {
  const v = Array(128).fill(0);
  for (const word of terms(value)) v[parseInt(digest(word).slice(0, 8), 16) % v.length]++;
  const norm = Math.hypot(...v) || 1; return v.map(x => x / norm);
}
export function budget(text, tokens) {
  // A conservative UTF-8 byte cap, not a claim to know every provider's tokenizer.
  let bytes = 0; let out = '';
  for (const char of text) { bytes += Buffer.byteLength(char); if (bytes > tokens) break; out += char; }
  return out;
}
function initialModel(identity) {
  return { identity: { id: identity, substrate: 'DSH', anchor: 'OTREE 的快乐小鲸鱼；身份称呼不证明主观情绪',
    continuity: '身份记录、经历和自我模型独立于当前 Session 与底层模型名称。' },
    ...Object.fromEntries(SELF_FIELDS.map(k => [k, []])) };
}

export class CognitiveStore {
  constructor(dir, { selfTokenBudget = 2400 } = {}) {
    this.selfTokenBudget = selfTokenBudget;
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dir, 'cognitive.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,identity TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,last_activity INTEGER NOT NULL,daily_watermark INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bindings(session TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,kind TEXT NOT NULL,query TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS bridge_receipts(job TEXT PRIMARY KEY,scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suppressed_sessions(session TEXT PRIMARY KEY,scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_events(n INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,session TEXT NOT NULL,seq TEXT NOT NULL,root TEXT NOT NULL,source TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '{}',UNIQUE(scope,session,seq));
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,kind TEXT NOT NULL,text TEXT NOT NULL,source TEXT NOT NULL,confidence REAL NOT NULL,evidence TEXT NOT NULL,entities TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,supersedes TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(scope TEXT NOT NULL,src TEXT NOT NULL,dst TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope,src,dst,kind));
      CREATE TABLE IF NOT EXISTS self_versions(scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,version INTEGER NOT NULL,previous_version INTEGER,timestamp INTEGER NOT NULL,model TEXT NOT NULL,change_summary TEXT NOT NULL,evidence_refs TEXT NOT NULL,proposer TEXT NOT NULL,validation_result TEXT NOT NULL,PRIMARY KEY(scope,version));
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,base INTEGER NOT NULL,payload TEXT NOT NULL,proposer TEXT NOT NULL,result INTEGER);
      CREATE TABLE IF NOT EXISTS diaries(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,day TEXT NOT NULL,text TEXT NOT NULL,evidence TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,text TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,kind TEXT NOT NULL,day TEXT NOT NULL,boundary INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,session TEXT NOT NULL,request_id TEXT NOT NULL,result TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_attempts(task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,attempt INTEGER NOT NULL,session TEXT NOT NULL,request_id TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(task,attempt));
      CREATE TABLE IF NOT EXISTS cognitive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO cognitive_meta VALUES('schema','1');
      CREATE INDEX IF NOT EXISTS raw_scope ON raw_events(scope,n);
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,active);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,scope UNINDEXED,text);
      CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(id UNINDEXED,scope UNINDEXED,text);
      CREATE TRIGGER IF NOT EXISTS raw_insert AFTER INSERT ON raw_events BEGIN INSERT INTO raw_fts(id,scope,text) VALUES(new.id,new.scope,new.text); END;
      CREATE TRIGGER IF NOT EXISTS raw_delete AFTER DELETE ON raw_events BEGIN DELETE FROM raw_fts WHERE id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(id,scope,text) VALUES(new.id,new.scope,new.text); END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_fts WHERE id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memories BEGIN DELETE FROM memory_fts WHERE id=old.id; INSERT INTO memory_fts(id,scope,text) VALUES(new.id,new.scope,new.text); END;`);
    if (this.db.prepare("SELECT value FROM cognitive_meta WHERE key='schema'").get().value !== '1') fail('schema');
    for (const table of ['bindings', 'raw_events']) if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'actor')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN actor TEXT NOT NULL DEFAULT '{}'`);
    if (process.platform !== 'win32') fs.chmodSync(path.join(this.dir, 'cognitive.sqlite'), 0o600);
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const x = fn(); this.db.exec('COMMIT'); return x; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  scope(_account, _user, now = Date.now()) {
    // One continuous Agent Self and memory space for this entire instance. Participants are provenance, not partitions.
    const id = SHARED_SCOPE;
    this.tx(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO scopes(id,identity,last_activity) VALUES(?,?,?)').run(id, randomUUID(), now);
      if (result.changes) {
        const row = this.db.prepare('SELECT identity FROM scopes WHERE id=?').get(id);
        this.db.prepare('INSERT INTO self_versions VALUES(?,?,?,?,?,?,?,?,?)').run(id, 1, null, now, JSON.stringify(initialModel(row.identity)), '初始化：尚无稳定行为特征', '[]', 'bootstrap', 'validated-initial-state');
      }
    });
    return id;
  }
  bind(scope, session, query = '', kind = 'conversation', actor = {}) {
    if (this.db.prepare('SELECT 1 FROM suppressed_sessions WHERE session=?').get(session)) fail('session-forgotten');
    const old = this.binding(session);
    if (old && (old.scope !== scope || old.kind !== kind)) fail('scope-conflict');
    this.db.prepare('INSERT INTO bindings(session,scope,kind,query,actor) VALUES(?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET query=excluded.query,actor=excluded.actor').run(session, scope, kind, clean(query, 2000), JSON.stringify(actor));
  }
  binding(session) { return this.db.prepare('SELECT * FROM bindings WHERE session=?').get(session); }
  record(scope, { session, seq, root, source, text, at = Date.now(), actor }) {
    if (!['user_statement', 'assistant_narrative', 'tool_result', 'tool_action', 'observed_outcome', 'runtime', 'external_document'].includes(source)) fail('source');
    const safe = clean(text); if (!safe) return null;
    const id = 'e-' + digest(JSON.stringify([scope, session, String(seq)])).slice(0, 40);
    this.db.prepare('INSERT OR IGNORE INTO raw_events(id,scope,session,seq,root,source,text,at,actor) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, scope, session, String(seq), root ?? session, source, safe, at, JSON.stringify(actor ?? JSON.parse(this.binding(session)?.actor ?? '{}')));
    return id;
  }
  activity(scope, now = Date.now()) { this.db.prepare('UPDATE scopes SET last_activity=? WHERE id=?').run(now, scope); }
  evidence(scope, refs, table = 'raw_events') {
    if (!['raw_events', 'memories'].includes(table) || !Array.isArray(refs) || !refs.length || refs.length > 24 || refs.some(r => typeof r !== 'string')) fail('evidence-required');
    return [...new Set(refs)].map(id => {
      const row = this.db.prepare(`SELECT * FROM ${table} WHERE scope=? AND id=?`).get(scope, id);
      if (!row || (table === 'memories' && !row.active)) fail('evidence-missing'); return row;
    });
  }
  remember(scope, item, key = randomUUID()) {
    if (!MEMORY_KINDS.includes(item.kind) || !['user_statement', 'tool_verified', 'external_document', 'inference'].includes(item.source)) fail('memory-shape');
    const text = plain(item.text); if (injection.test(text)) fail('instruction-in-data');
    if (!Array.isArray(item.evidence) || !item.evidence.length) fail('evidence-required');
    const rows = this.evidence(scope, item.evidence.map(x => x.id));
    for (const citation of item.evidence) {
      if (typeof citation.quote !== 'string' || citation.quote.length < 2 || !rows.find(r => r.id === citation.id)?.text.includes(citation.quote)) fail('evidence-quote');
    }
    if (item.source === 'user_statement' && !rows.some(r => r.source === 'user_statement')) fail('source-mismatch');
    if (item.source === 'tool_verified' && !rows.some(r => r.source === 'tool_result')) fail('source-mismatch');
    if (item.source === 'external_document' && !rows.some(r => r.source === 'external_document')) fail('source-mismatch');
    if (item.kind === 'procedural' && !rows.some(r => {
      if (r.source !== 'tool_result') return false;
      try { const data = JSON.parse(r.text); return data.message && data.message.isError !== true && !data.error; } catch { return false; }
    })) fail('procedure-unverified');
    const entities = (item.entities ?? []).slice(0, 12).map(x => plain(x, 80));
    const prior = item.supersedes?.length ? this.evidence(scope, item.supersedes, 'memories') : [];
    const existing = this.db.prepare('SELECT * FROM memories WHERE scope=? AND active=1 AND kind=? AND source=? AND text=?').get(scope, item.kind, item.source, text);
    const id = existing?.id ?? 'm-' + digest(scope + ':' + key).slice(0, 40);
    const score = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0.5;
    const confidence = item.source === 'inference' ? Math.min(0.5, score) : score;
    for (const linked of item.relatedTo ?? []) this.evidence(scope, [linked], 'memories');
    this.db.prepare('INSERT OR IGNORE INTO memories(id,scope,kind,text,source,confidence,evidence,entities,created,supersedes) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, scope, item.kind, text, item.source, confidence, JSON.stringify(item.evidence), JSON.stringify(entities), Date.now(), JSON.stringify(prior.map(r => r.id)));
    this.db.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?)').run(id, JSON.stringify(vector(text + ' ' + entities.join(' '))));
    if (existing) {
      const merged = [...JSON.parse(existing.evidence)];
      for (const citation of item.evidence) if (!merged.some(e => e.id === citation.id && e.quote === citation.quote)) merged.push(citation);
      // A bounded citation set avoids unbounded prompt growth; original events remain independently searchable.
      const evidence = JSON.stringify(merged.slice(-24));
      if (evidence !== existing.evidence) this.db.prepare('UPDATE memories SET evidence=?,revision=revision+1 WHERE id=?').run(evidence, id);
    }
    for (const old of prior) {
      if (old.id === id) continue;
      this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(old.id);
      this.db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?,?)').run(scope, id, old.id, 'corrects');
    }
    for (const linked of item.relatedTo ?? []) {
      this.evidence(scope, [linked], 'memories');
      this.db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?,?)').run(scope, id, linked, 'relates');
    }
    return id;
  }
  current(scope) {
    const row = this.db.prepare('SELECT v.* FROM self_versions v JOIN scopes s ON s.id=v.scope AND s.version=v.version WHERE v.scope=?').get(scope);
    if (!row) fail('scope-missing');
    return { ...row, model: JSON.parse(row.model), evidence_refs: JSON.parse(row.evidence_refs) };
  }
  validateSelf(scope, proposal) {
    if (!proposal || typeof proposal !== 'object' || !Number.isInteger(proposal.baseVersion) || !proposal.changes || Array.isArray(proposal.changes)) fail('self-shape');
    if (Object.keys(proposal).some(k => !['baseVersion', 'changes', 'summary', 'evidenceRefs'].includes(k))
      || Object.keys(proposal.changes).some(k => !SELF_FIELDS.includes(k))) fail('self-boundary');
    const current = this.current(scope); if (current.version !== proposal.baseVersion) fail('version-conflict');
    const model = structuredClone(current.model); const citations = new Set(proposal.evidenceRefs ?? []);
    for (const [field, list] of Object.entries(proposal.changes)) {
      if (!Array.isArray(list) || list.length > 10) fail('self-shape');
      model[field] = list.map(item => {
        if (!item || Object.keys(item).some(k => !['text', 'evidenceRefs', 'confidence'].includes(k))) fail('self-shape');
        const text = plain(item.text, 400); if (injection.test(text)) fail('instruction-in-data');
        const memories = this.evidence(scope, item.evidenceRefs, 'memories');
        const events = memories.flatMap(m => this.evidence(scope, JSON.parse(m.evidence).map(e => e.id)));
        const external = events.filter(e => ['user_statement', 'tool_result', 'observed_outcome'].includes(e.source));
        if (!external.length) fail('self-confirmation-loop');
        if (['traits', 'values', 'preferences'].includes(field) && (new Set(external.map(e => e.root)).size < 2
          || new Set(external.map(e => e.source + ':' + digest(e.text))).size < 2)) fail('trait-needs-independent-experiences');
        const confidence = item.confidence ?? 'tentative';
        if (!['tentative', 'supported', 'uncertain'].includes(confidence)) fail('self-confidence');
        item.evidenceRefs.forEach(id => citations.add(id));
        return { text, evidenceRefs: [...new Set(item.evidenceRefs)], confidence };
      });
    }
    if (JSON.stringify(model) === JSON.stringify(current.model)) return { noop: true, current };
    this.evidence(scope, [...citations], 'memories');
    plain(proposal.summary, 240);
    if (injection.test(proposal.summary)) fail('instruction-in-data');
    if (Buffer.byteLength(JSON.stringify({ version: current.version + 1, model, retiredClaims: 0 })) + 160 > this.selfTokenBudget) fail('self-too-large');
    return { current, model, citations: [...citations] };
  }
  propose(scope, proposal, proposer = 'agent') {
    const valid = this.validateSelf(scope, proposal);
    if (valid.noop) return { noop: true, version: valid.current.version };
    const id = randomUUID();
    this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,NULL)').run(id, scope, proposal.baseVersion, JSON.stringify(proposal), proposer);
    return { id, baseVersion: proposal.baseVersion };
  }
  commit(scope, id, { inTransaction = false, project = true } = {}) {
    const write = () => {
      const p = this.db.prepare('SELECT * FROM proposals WHERE scope=? AND id=?').get(scope, id); if (!p) fail('proposal-missing');
      if (p.result) return { version: p.result, replay: true };
      const proposal = JSON.parse(p.payload); const v = this.validateSelf(scope, proposal);
      if (v.noop) return { noop: true, version: v.current.version };
      const version = v.current.version + 1;
      this.db.prepare('INSERT INTO self_versions VALUES(?,?,?,?,?,?,?,?,?)').run(scope, version, v.current.version, Date.now(), JSON.stringify(v.model), proposal.summary, JSON.stringify(v.citations), p.proposer, 'scope/evidence/source/injection/CAS/integrity-validated');
      const changed = this.db.prepare('UPDATE scopes SET version=? WHERE id=? AND version=?').run(version, scope, v.current.version).changes;
      if (!changed) fail('version-conflict');
      this.db.prepare('UPDATE proposals SET result=? WHERE id=?').run(version, id);
      return { version };
    };
    const result = inTransaction ? write() : this.tx(write);
    if (project) this.mirror(scope); return result;
  }
  history(scope) { return this.db.prepare('SELECT version,previous_version,timestamp,change_summary,evidence_refs,proposer,validation_result FROM self_versions WHERE scope=? ORDER BY version').all(scope); }
  rollback(scope, version, reason) {
    const old = this.db.prepare('SELECT model FROM self_versions WHERE scope=? AND version=?').get(scope, version); if (!old) fail('version-missing');
    const current = this.current(scope); const model = JSON.parse(old.model);
    const evidenceRefs = [...new Set([...SELF_FIELDS.flatMap(k => current.model[k].flatMap(x => x.evidenceRefs)), ...SELF_FIELDS.flatMap(k => model[k].flatMap(x => x.evidenceRefs))])];
    const p = this.propose(scope, { baseVersion: current.version, changes: Object.fromEntries(SELF_FIELDS.map(k => [k, model[k]])), summary: '回滚：' + plain(reason, 200), evidenceRefs }, 'rollback');
    return p.noop ? p : this.commit(scope, p.id);
  }
  visibleSelf(scope) {
    const current = this.current(scope); const model = structuredClone(current.model); let retired = 0;
    for (const field of SELF_FIELDS) model[field] = model[field].filter(item => {
      const valid = item.evidenceRefs.every(id => this.db.prepare('SELECT active FROM memories WHERE scope=? AND id=?').get(scope, id)?.active);
      if (!valid) retired++; return valid;
    });
    return { version: current.version, model, retiredClaims: retired };
  }
  mirror(scope) {
    if (scope !== SHARED_SCOPE) fail('scope-id');
    const dir = path.join(this.dir, 'self'); fs.mkdirSync(path.join(dir, 'versions'), { recursive: true, mode: 0o700 });
    const current = this.current(scope); const visible = this.visibleSelf(scope);
    const files = { 'SELF_MODEL.md': '# Evolving Self\n\n数据库权威记录的只读投影；修改此文件不影响注入。\n\n```json\n' + JSON.stringify(visible, null, 2) + '\n```\n',
      'self-state.json': JSON.stringify(visible, null, 2) };
    for (const row of this.db.prepare('SELECT * FROM self_versions WHERE scope=? ORDER BY version').all(scope)) files['versions/' + row.version + '.json'] = JSON.stringify({ ...row, model: JSON.parse(row.model) }, null, 2);
    for (const [file, content] of Object.entries(files)) {
      const dest = path.join(dir, file); if (fs.existsSync(dest) && digest(fs.readFileSync(dest)) === digest(content)) continue;
      const tmp = dest + '.' + randomUUID() + '.tmp'; fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, dest);
    }
    return current.version;
  }
  retrieve(scope, query, limit = 8, now = Date.now()) {
    const words = terms(query); const qv = vector(query); const lexical = new Set();
    if (words.length) {
      const match = words.slice(0, 20).map(w => '"' + w.replaceAll('"', '""') + '"').join(' OR ');
      for (const row of this.db.prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND scope=? LIMIT 80').all(match, scope)) lexical.add(row.id);
    }
    const goals = this.db.prepare("SELECT text FROM goals WHERE scope=? AND status='active'").all(scope);
    const candidates = this.db.prepare('SELECT m.*,v.value FROM memories m JOIN vectors v ON v.id=m.id WHERE m.scope=? AND m.active=1 ORDER BY m.created DESC LIMIT 1000').all(scope);
    const candidate = id => this.db.prepare('SELECT m.*,v.value FROM memories m JOIN vectors v ON v.id=m.id WHERE m.scope=? AND m.active=1 AND m.id=?').get(scope, id);
    for (const id of lexical) if (!candidates.some(m => m.id === id)) { const old = candidate(id); if (old) candidates.push(old); }
    const score = m => {
      const lower = m.text.toLocaleLowerCase(); const keyword = words.filter(w => lower.includes(w)).length;
      const cosine = JSON.parse(m.value).reduce((s, n, i) => s + n * qv[i], 0);
      const entities = JSON.parse(m.entities); const entity = entities.some(e => query.toLocaleLowerCase().includes(e.toLocaleLowerCase())) ? 1 : 0;
      const goal = goals.some(g => terms(g.text).some(w => lower.includes(w))) ? 1 : 0;
      const direct = lexical.has(m.id) || keyword > 0 || entity > 0 || cosine > 0.16;
      const freshness = Math.exp(-Math.max(0, now - m.created) / (30 * 86400000));
      return { ...m, score: (lexical.has(m.id) ? 2 : 0) + keyword + cosine + entity + goal * 0.5 + freshness * 0.2 + (m.source === 'inference' ? 0.1 : m.source === 'external_document' ? 0.2 : 0.5) + m.confidence * 0.2, direct };
    };
    const scored = candidates.map(score);
    const roots = new Set(scored.filter(m => m.direct).sort((a, b) => b.score - a.score).slice(0, 24).map(m => m.id));
    const connected = new Set(this.db.prepare("SELECT src,dst FROM edges WHERE scope=? AND kind='relates'").all(scope).flatMap(e => roots.has(e.src) ? [e.dst] : roots.has(e.dst) ? [e.src] : []));
    for (const id of connected) if (!scored.some(m => m.id === id)) { const old = candidate(id); if (old) scored.push(score(old)); }
    return scored.filter(m => m.direct || connected.has(m.id)).map(m => ({ ...m, score: m.score + (connected.has(m.id) ? 0.5 : 0) })).sort((a, b) => b.score - a.score).slice(0, Math.min(20, limit))
      .map(({ value, direct, ...m }) => ({ ...m, evidence: JSON.parse(m.evidence), entities: JSON.parse(m.entities),
        participants: this.evidence(scope, JSON.parse(m.evidence).map(e => e.id)).map(e => ({ actor: JSON.parse(e.actor), at: e.at, source: e.source })),
        uncertainty: m.source === 'inference' ? '推断，尚未证实' : m.source === 'external_document' ? '外部资料记录，内容未被独立核实' : '有来源记录；可能随时间过时', confidenceMeaning: '辅助估计，不是严格概率' }));
  }
  trace(scope, id) {
    const memory = this.db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(scope, id); if (!memory) fail('evidence-missing');
    return { ...memory, sources: this.evidence(scope, JSON.parse(memory.evidence).map(e => e.id)) };
  }
  rawSearch(scope, query) {
    const words = terms(query); let ids = [];
    if (words.length) ids = this.db.prepare('SELECT id FROM raw_fts WHERE raw_fts MATCH ? AND scope=? LIMIT 20')
      .all(words.slice(0, 20).map(w => '"' + w.replaceAll('"', '""') + '"').join(' OR '), scope).map(r => r.id);
    const rows = this.db.prepare('SELECT id,session,root,source,text,at,actor FROM raw_events WHERE scope=? AND instr(lower(text),lower(?))>0 ORDER BY n DESC LIMIT 10').all(scope, query);
    for (const id of ids) if (!rows.some(r => r.id === id)) rows.push(this.db.prepare('SELECT id,session,root,source,text,at,actor FROM raw_events WHERE scope=? AND id=?').get(scope, id));
    return rows.slice(0, 10).map(r => ({ ...r, text: budget(r.text, 600), actor: JSON.parse(r.actor), excerpt: true }));
  }
}
