import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { textMessage } from './ilink.js';
import { BridgeError } from './util.js';
import { clean } from './cognitive/store.js';

export class Store {
  constructor(file, { readOnly = false } = {}) {
    this.db = new DatabaseSync(file, { readOnly });
    if (readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(account TEXT NOT NULL,user TEXT NOT NULL,session TEXT NOT NULL UNIQUE,cursor INTEGER NOT NULL DEFAULT -1,
        PRIMARY KEY(account,user));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,user TEXT NOT NULL,message_id TEXT NOT NULL,payload TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'queued',session TEXT,turn INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL,
        retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(account,user,message_id));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,account TEXT NOT NULL,user TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,created INTEGER NOT NULL,server_id TEXT);
      CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,seq));
      CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,session TEXT NOT NULL,account TEXT NOT NULL,user TEXT NOT NULL,event_id TEXT NOT NULL,
        client_id TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',UNIQUE(session,event_id));
      CREATE TABLE IF NOT EXISTS quarantine(account TEXT NOT NULL,id TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(account,id));
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,retry_at,created);
      CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state,retry_at,created);`);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema','1')").run();
    if (this.get('schema') !== '1') throw new Error('unsupported database schema');
    this.initSessions();
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const x = fn(); this.db.exec('COMMIT'); return x; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value)); }
  recover() {
    // A crashed sender may have succeeded remotely. Never auto-replay this state.
    this.db.exec("UPDATE outbox SET state='unknown',error='process-interrupted' WHERE state='sending'; UPDATE pending SET state='stale' WHERE state IN ('pending','answering')");
  }
  ingest(account, response, allowed, maxTextChars, { imagesEnabled = false, maxImages = 4 } = {}) {
    return this.tx(() => {
      for (const m of response.msgs ?? []) {
        const user = m.from_user_id;
        if (m.message_type !== 1 || !user || !allowed.has(user) || m.group_id) continue;
        const invalid = typeof m.context_token !== 'string' || !m.context_token ? 'missing-context'
          : typeof m.message_id !== 'string' || !m.message_id ? 'missing-stable-id'
          : !Array.isArray(m.item_list) ? 'invalid-items' : null;
        if (invalid) {
          const payload = JSON.stringify(m); const id = createHash('sha256').update(payload).digest('hex');
          this.db.prepare('INSERT OR IGNORE INTO quarantine VALUES(?,?,?,?,?)').run(account, id, invalid, payload, Date.now()); continue;
        }
        const items = m.item_list ?? [];
        const images = items.filter(i => i?.type === 2 && i.image_item).map(i => i.image_item);
        const rawText = items.filter(i => i?.type === 1 && typeof i.text_item?.text === 'string').map(i => i.text_item.text).join('\n');
        const text = rawText || (imagesEnabled && images.length ? `[图片 × ${images.length}]` : '');
        const supported = items.length > 0 && items.every(i => i?.type === 1 && typeof i.text_item?.text === 'string' || imagesEnabled && i?.type === 2 && i.image_item)
          && images.length <= maxImages;
        if (m.message_state !== undefined && ![0, 2].includes(m.message_state)) continue;
        const payload = JSON.stringify({ text, context: m.context_token, runId: m.run_id, supported, ...(imagesEnabled && images.length ? { images } : {}) });
        const state = supported && text.trim() && text.length <= maxTextChars ? 'queued' : 'rejected';
        const now = Date.now();
        const result = this.db.prepare('INSERT OR IGNORE INTO jobs(id,account,user,message_id,payload,request_id,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), account, user, String(m.message_id), payload, randomUUID(), state, now, now);
        if (result.changes) {
          const job = this.db.prepare('SELECT * FROM jobs WHERE account=? AND user=? AND message_id=?').get(account, user, String(m.message_id));
          const sid = this.ensureMapping(account, user).session;
          this.db.prepare('UPDATE jobs SET session=? WHERE id=?').run(sid, job.id);
          this.chat('user:' + job.id, sid, 'user', { accountId: account, userId: user }, text, now, job.id);
        }
        if (result.changes && state === 'rejected') this.reply({ account, user, payload }, '仅接收长度范围内的文本和已启用的图片；请检查图片数量及消息类型。', `unsupported:${account}:${user}:${m.message_id}`);
      }
      if (typeof response.get_updates_buf === 'string') this.set('cursor:' + account, response.get_updates_buf);
    });
  }
  initSessions() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions(session TEXT PRIMARY KEY,title TEXT NOT NULL,created INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT -1);
      CREATE UNIQUE INDEX IF NOT EXISTS single_active_chat ON chat_sessions(archived) WHERE archived=0;
      CREATE TABLE IF NOT EXISTS chat_entries(n INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session TEXT NOT NULL REFERENCES chat_sessions(session),role TEXT NOT NULL,actor TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,job TEXT);
      CREATE INDEX IF NOT EXISTS chat_history ON chat_entries(session,n);
      CREATE TRIGGER IF NOT EXISTS preserve_chat_session BEFORE DELETE ON chat_sessions BEGIN SELECT RAISE(ABORT,'sessions-are-archived-not-deleted'); END;`);
    if (!this.db.prepare('PRAGMA table_info(chat_sessions)').all().some(c => c.name === 'kind')) this.db.exec("ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation'");
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'kind')) this.db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation'");
    this.db.exec("DROP INDEX IF EXISTS single_active_chat; CREATE UNIQUE INDEX single_active_chat ON chat_sessions(kind) WHERE archived=0; DROP TRIGGER IF EXISTS preserve_chat_session; CREATE TRIGGER preserve_chat_session BEFORE DELETE ON chat_sessions WHEN old.kind!='test' BEGIN SELECT RAISE(ABORT,'sessions-are-archived-not-deleted'); END;");
    if (!this.get('managed-sessions')) this.tx(() => {
      const legacy = this.db.prepare('SELECT * FROM conversations ORDER BY rowid').all();
      for (const row of legacy) this.db.prepare('INSERT OR IGNORE INTO chat_sessions(session,title,created,archived,cursor) VALUES(?,?,?,?,?)').run(row.session, '导入的历史会话', Date.now(), 1, row.cursor);
      // Jobs from interrupted turns keep their original Session; migration never moves a request.
      for (const row of this.db.prepare('SELECT DISTINCT session FROM jobs WHERE session IS NOT NULL').all()) this.db.prepare('INSERT OR IGNORE INTO chat_sessions(session,title,created,archived,cursor) VALUES(?,?,?,?,?)').run(row.session, '导入的历史会话', Date.now(), 1, -1);
      const first = this.db.prepare("SELECT session FROM jobs WHERE session IS NOT NULL AND state IN ('submitting','waiting','review') ORDER BY created LIMIT 1").get()
        ?? this.db.prepare('SELECT session FROM chat_sessions ORDER BY created,rowid LIMIT 1').get();
      if (first) this.db.prepare('UPDATE chat_sessions SET archived=0 WHERE session=?').run(first.session);
      for (const row of this.db.prepare("SELECT DISTINCT session FROM jobs WHERE session IS NOT NULL AND attempts>0").all()) this.set('dsh-created:' + row.session, '1');
      this.set('managed-sessions', '1');
    });
    // One-time idempotent import of text-only public records. Preserve each legacy Session's event order.
    if (!this.get('chat-history-imported')) this.tx(() => {
      for (const s of this.db.prepare('SELECT session FROM chat_sessions').all()) {
        const jobs = this.db.prepare('SELECT * FROM jobs WHERE session=? ORDER BY created,rowid').all(s.session);
        const requests = new Map(jobs.map(j => [j.request_id, j])); let current;
        const user = j => this.chat('user:' + j.id, s.session, 'user', { accountId: j.account, userId: j.user }, JSON.parse(j.payload).text, j.created, j.id);
        for (const row of this.db.prepare("SELECT * FROM events WHERE session=? AND type IN ('user/message','assistant/message') ORDER BY seq").all(s.session)) {
          const data = JSON.parse(row.data);
          if (row.type === 'user/message') { current = requests.get(data.source?.rpcId); if (current) user(current); }
          else this.chat('assistant:' + s.session + ':' + row.seq, s.session, 'assistant', {}, data.text, current?.updated ?? Date.now(), current?.id);
        }
        for (const j of jobs) user(j); // Also retain messages never admitted to DSH.
      }
      this.set('chat-history-imported', '1');
    });
  }
  session(id) { return typeof id === 'string' ? this.db.prepare('SELECT * FROM chat_sessions WHERE session=?').get(id) : undefined; }
  currentSession(kind = 'conversation') { return this.db.prepare('SELECT * FROM chat_sessions WHERE archived=0 AND kind=?').get(kind); }
  mapping(account, user) { const row = this.currentSession(); return row && { ...row, account, user }; }
  ensureMapping(account, user) {
    if (!this.currentSession()) this.db.prepare('INSERT INTO chat_sessions(session,title,created,archived,cursor) VALUES(?,?,?,?,?)').run(randomUUID(), '最初的会话', Date.now(), 0, -1);
    return this.mapping(account, user);
  }
  chat(id, session, role, actor, text, created = Date.now(), job = null) {
    if (!text || !session) return;
    this.db.prepare('INSERT OR IGNORE INTO chat_entries(id,session,role,actor,text,created,job) VALUES(?,?,?,?,?,?,?)')
      .run(id, session, role, JSON.stringify(actor), clean(text, 100000), created, job);
  }
  sessionControl(action, args = {}) {
    if (action === 'list') return { sessions: this.db.prepare('SELECT s.*,(SELECT count(*) FROM chat_entries e WHERE e.session=s.session) AS messages FROM chat_sessions s ORDER BY archived,created DESC,rowid DESC').all() };
    if (action === 'history') {
      if (!this.session(args.session)) throw new BridgeError('session-not-found');
      const before = Number.isSafeInteger(args.before) && args.before > 0 ? args.before : Number.MAX_SAFE_INTEGER;
      const rows = this.db.prepare('SELECT * FROM chat_entries WHERE session=? AND n<? ORDER BY n DESC LIMIT 100').all(args.session, before);
      const entries = []; let bytes = 0;
      for (const row of rows) { const size = Buffer.byteLength(JSON.stringify(row)); if (entries.length && bytes + size > 750000) break; entries.push(row); bytes += size; }
      entries.reverse();
      return { entries: entries.map(e => ({ ...e, actor: JSON.parse(e.actor) })), hasMore: Boolean(entries.length && this.db.prepare('SELECT 1 FROM chat_entries WHERE session=? AND n<? LIMIT 1').get(args.session, entries[0].n)) };
    }
    if (!['create', 'switch', 'archive'].includes(action)) throw new BridgeError('session-action-invalid');
    return this.tx(() => {
      const kind = action === 'create' ? args.kind ?? 'conversation' : this.session(args.session)?.kind;
      if (!['conversation', 'test'].includes(kind)) throw new BridgeError('session-kind-invalid');
      if (this.db.prepare("SELECT 1 FROM jobs j JOIN chat_sessions s ON s.session=j.session WHERE s.kind=? AND j.state IN ('queued','backoff','submitting','waiting','review') LIMIT 1").get(kind)
        || this.db.prepare("SELECT 1 FROM pending p JOIN chat_sessions s ON s.session=p.session WHERE s.kind=? AND p.state IN ('pending','answering','unknown') LIMIT 1").get(kind)
        || kind === 'conversation' && this.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','sending','unknown') LIMIT 1").get()) throw new BridgeError('session-busy');
      let id = args.session;
      if (action === 'create') {
        if (args.title !== undefined && typeof args.title !== 'string') throw new BridgeError('session-title-invalid');
        const title = args.title?.trim() || '新的会话';
        if (typeof title !== 'string' || title.length > 100 || clean(title) !== title) throw new BridgeError('session-title-invalid');
        id = randomUUID();
        this.db.prepare('INSERT INTO chat_sessions(session,title,created,archived,cursor,kind) VALUES(?,?,?,?,?,?)').run(id, title, Date.now(), 1, -1, kind);
      } else if (!this.session(id)) throw new BridgeError('session-not-found');
      if (action === 'archive') {
        if (this.currentSession(kind)?.session === id) throw new BridgeError('session-active-archive');
        this.db.prepare('UPDATE chat_sessions SET archived=1 WHERE session=?').run(id);
      } else {
        this.db.prepare('UPDATE chat_sessions SET archived=1 WHERE archived=0 AND kind=?').run(kind);
        this.db.prepare('UPDATE chat_sessions SET archived=0 WHERE session=?').run(id);
      }
      return { session: id, ...this.sessionControl('list') };
    });
  }
  job(id) { return typeof id === 'string' ? this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) : undefined; }
  updateJob(id, state, error = null, retryAt = 0) { this.db.prepare('UPDATE jobs SET state=?,error=?,retry_at=?,updated=? WHERE id=?').run(state, error, retryAt, Date.now(), id); }
  reply(job, text, id, maxChars = 2000) {
    const sid = this.job(job.id)?.session ?? job.session;
    if (this.session(sid)?.kind === 'test' || job.kind === 'alarm') { this.chat('bridge:' + id, sid, 'bridge', {}, text, Date.now(), job.id); return; }
    // Agent text is stored from durable DSH events; transport/control notices have a distinct role.
    if (!id.startsWith('result:') && !id.startsWith('emission:')) this.chat('bridge:' + id, sid, 'bridge', {}, text, Date.now(), job.id);
    const p = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    const chars = Array.from(text); let part = 0;
    for (let start = 0; start < chars.length; start += maxChars) {
      const key = id + ':' + part++;
      const body = textMessage(job.user, chars.slice(start, start + maxChars).join(''), p.context, 'dsfriend-' + createHash('sha256').update(key).digest('hex').slice(0, 40), p.runId);
      this.db.prepare('INSERT OR IGNORE INTO outbox(id,account,user,body,created) VALUES(?,?,?,?,?)').run(key, job.account, job.user, JSON.stringify(body), Date.now());
    }
  }
  active(session) { return this.db.prepare("SELECT * FROM jobs WHERE session=? AND state IN ('submitting','waiting','review') ORDER BY created LIMIT 1").get(session); }
  stats() {
    return { jobs: this.db.prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state').all(),
      quarantine: this.db.prepare('SELECT reason,count(*) AS count FROM quarantine GROUP BY reason').all(),
      outbox: this.db.prepare('SELECT state,count(*) AS count FROM outbox GROUP BY state').all(),
      issues: this.db.prepare("SELECT id,state,error FROM jobs WHERE state IN ('review','backoff') OR (state='done' AND error LIKE 'dsh-%') ORDER BY created").all(),
      unknown: this.db.prepare("SELECT id,state,error FROM outbox WHERE state IN ('unknown','failed') ORDER BY created").all() };
  }
}
