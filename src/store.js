import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { textMessage } from './ilink.js';

export class Store {
  constructor(file, { readOnly = false } = {}) {
    this.db = new DatabaseSync(file, { readOnly });
    if (readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
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
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const x = fn(); this.db.exec('COMMIT'); return x; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value)); }
  recover() {
    // A crashed sender may have succeeded remotely. Never auto-replay this state.
    this.db.exec("UPDATE outbox SET state='unknown',error='process-interrupted' WHERE state='sending'; UPDATE pending SET state='stale' WHERE state IN ('pending','answering')");
  }
  ingest(account, response, allowed, maxTextChars) {
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
        const text = items.filter(i => i?.type === 1 && typeof i.text_item?.text === 'string').map(i => i.text_item.text).join('\n');
        const supported = items.length > 0 && items.every(i => i?.type === 1 && typeof i.text_item?.text === 'string');
        if (m.message_state !== undefined && ![0, 2].includes(m.message_state)) continue;
        const payload = JSON.stringify({ text, context: m.context_token, runId: m.run_id, supported });
        const state = supported && text.trim() && text.length <= maxTextChars ? 'queued' : 'rejected';
        const now = Date.now();
        const result = this.db.prepare('INSERT OR IGNORE INTO jobs(id,account,user,message_id,payload,request_id,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), account, user, String(m.message_id), payload, randomUUID(), state, now, now);
        if (result.changes && state === 'rejected') this.reply({ account, user, payload }, '首版只接收非空文本消息，且需在长度限制内。', `unsupported:${account}:${user}:${m.message_id}`);
      }
      if (typeof response.get_updates_buf === 'string') this.set('cursor:' + account, response.get_updates_buf);
    });
  }
  mapping(account, user) { return this.db.prepare('SELECT * FROM conversations WHERE account=? AND user=?').get(account, user); }
  ensureMapping(account, user) {
    this.db.prepare('INSERT OR IGNORE INTO conversations(account,user,session) VALUES(?,?,?)').run(account, user, randomUUID());
    return this.mapping(account, user);
  }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  updateJob(id, state, error = null, retryAt = 0) { this.db.prepare('UPDATE jobs SET state=?,error=?,retry_at=?,updated=? WHERE id=?').run(state, error, retryAt, Date.now(), id); }
  reply(job, text, id, maxChars = 2000) {
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
      issues: this.db.prepare("SELECT id,state,error FROM jobs WHERE state IN ('review','backoff') ORDER BY created").all(),
      unknown: this.db.prepare("SELECT id,state,error FROM outbox WHERE state IN ('unknown','failed') ORDER BY created").all() };
  }
}
