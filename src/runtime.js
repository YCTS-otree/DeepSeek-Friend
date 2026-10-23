import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './util.js';
import { clean } from './cognitive/store.js';
import { AddressBook } from './contacts.js';
const root = fileURLToPath(new URL('..', import.meta.url));
export const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek-V41-Flash' };
export const RUNTIME_DEFAULTS = { reasoningEffort: 'high', maxTokens: 8192, continuous: true, paused: false, continueDelayMs: 1000 };
export class RuntimeStore {
  constructor(dir) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dir, 'interaction.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contexts(session TEXT PRIMARY KEY,job TEXT NOT NULL,kind TEXT NOT NULL,rest INTEGER NOT NULL DEFAULT 0,preempt INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS emissions(id TEXT PRIMARY KEY,session TEXT NOT NULL,job TEXT NOT NULL,text TEXT NOT NULL,image TEXT,created INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'new');
      CREATE TABLE IF NOT EXISTS private_records(n INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(session,seq,kind));
      CREATE INDEX IF NOT EXISTS private_session ON private_records(session,n);
      CREATE TABLE IF NOT EXISTS alarms(id TEXT PRIMARY KEY,session TEXT NOT NULL,due INTEGER NOT NULL,note TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'scheduled',job TEXT,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS alarms_due ON alarms(state,due);
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,media_type TEXT NOT NULL,file TEXT NOT NULL,bytes INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,filekey TEXT NOT NULL,aes TEXT NOT NULL,result TEXT);`);
    if (!this.db.prepare('PRAGMA table_info(emissions)').all().some(c => c.name === 'delivery_job')) this.db.exec('ALTER TABLE emissions ADD COLUMN delivery_job TEXT');
    if (!this.db.prepare('PRAGMA table_info(contexts)').all().some(c => c.name === 'contact')) this.db.exec('ALTER TABLE contexts ADD COLUMN contact TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,account TEXT NOT NULL,user TEXT NOT NULL,job TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_routes(job TEXT PRIMARY KEY,session TEXT NOT NULL,request TEXT NOT NULL,start_seq INTEGER,closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reply_candidates(job TEXT NOT NULL,seq INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(job,seq));`);
    if (!this.db.prepare('PRAGMA table_info(reply_routes)').all().some(c => c.name === 'is_private')) this.db.exec('ALTER TABLE reply_routes ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
    this.addressBook = new AddressBook(this.db);
  }
  channelSettings(name, defaults = {}) { const row = this.db.prepare('SELECT v FROM settings WHERE k=?').get('channel:' + name); return { ...defaults, ...(row ? JSON.parse(row.v) : {}) }; }
  saveChannelSettings(name, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('channel:' + name, JSON.stringify(value)); return value; }
  close() { this.db.close(); }
  settings() { return { ...RUNTIME_DEFAULTS, ...Object.fromEntries(this.db.prepare("SELECT * FROM settings WHERE k NOT LIKE 'channel:%'").all().map(r => [r.k, JSON.parse(r.v)])), ...FLASH }; }
  configure(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(k => !Object.hasOwn(RUNTIME_DEFAULTS, k))) throw new BridgeError('runtime-settings-invalid');
    const s = { ...this.settings(), ...changes };
    if (!['off', 'low', 'high', 'max'].includes(s.reasoningEffort) || !Number.isSafeInteger(s.maxTokens) || s.maxTokens < 256 || s.maxTokens > 65536
      || typeof s.continuous !== 'boolean' || typeof s.paused !== 'boolean' || !Number.isSafeInteger(s.continueDelayMs) || s.continueDelayMs < 0 || s.continueDelayMs > 60000) throw new BridgeError('runtime-settings-invalid');
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const [k, v] of Object.entries(changes)) this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, JSON.stringify(v)); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.settings();
  }
  bind(session, job, kind = 'conversation', contact = null, request = null) {
    this.db.prepare('INSERT INTO contexts(session,job,kind,rest,preempt,updated,contact) VALUES(?,?,?,0,0,?,?) ON CONFLICT(session) DO UPDATE SET job=excluded.job,kind=excluded.kind,rest=0,preempt=0,updated=excluded.updated,contact=COALESCE(excluded.contact,contexts.contact)').run(session, job, kind, Date.now(), contact);
    if (request) this.prepareReply(session, request);
  }
  prepareReply(session, request) {
    const c = this.context(session); if (!c) throw new BridgeError('outbound-context-required');
    this.db.prepare('INSERT OR IGNORE INTO reply_routes(job,session,request) VALUES(?,?,?)').run(c.job, session, request);
  }
  finishReply(session) {
    const c = this.context(session); if (!c) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const route = this.db.prepare('SELECT * FROM reply_routes WHERE job=?').get(c.job);
      if (route && !route.closed) {
        const explicit = this.db.prepare('SELECT 1 FROM emissions WHERE job=?').get(c.job);
        const text = this.db.prepare('SELECT text FROM reply_candidates WHERE job=? ORDER BY seq').all(c.job).map(r => r.text).join('\n\n');
        if (explicit || route.is_private) this.db.prepare("INSERT OR IGNORE INTO private_records(session,seq,kind,text,created) SELECT ?,seq,'note',text,? FROM reply_candidates WHERE job=?").run(session, Date.now(), c.job);
        // Only the response phase is public. Continuation and historical notes never enter this queue.
        if (!explicit && !route.is_private && text.trim()) {
          const chars = Array.from(text);
          for (let i = 0; i < chars.length; i += 8000) this.emit(session, 'automatic-reply:' + i, chars.slice(i, i + 8000).join(''));
        }
        this.db.prepare('UPDATE reply_routes SET closed=1 WHERE job=?').run(c.job);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  context(session) { return typeof session === 'string' ? this.db.prepare('SELECT * FROM contexts WHERE session=?').get(session) : null; }
  flag(session, field, value = 1) { if (!['rest', 'preempt'].includes(field)) throw new BridgeError('runtime-flag'); this.db.prepare(`UPDATE contexts SET ${field}=?,updated=? WHERE session=?`).run(value, Date.now(), session); }
  contactId(job) { return 'contact-' + createHash('sha256').update(job.account + '\0' + job.user).digest('hex').slice(0, 20); }
  rememberContact(job) {
    const p = JSON.parse(job.payload); if ((!p.context && p.channel !== 'qq') || !job.user || job.kind === 'alarm' || job.kind === 'test') return;
    const id = this.contactId(job);
    this.db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET job=excluded.job,updated=excluded.updated WHERE excluded.updated>=contacts.updated').run(id, job.account, job.user, job.id, job.created);
  }
  contacts() { return this.db.prepare('SELECT id,account,user,updated FROM contacts ORDER BY updated DESC LIMIT 500').all().map(r => ({ ...r, channel: r.account.startsWith('qq:') ? 'qq' : 'weixin', ...this.addressBook.db.prepare('SELECT alias FROM address_book WHERE channel=? AND peer=?').get(r.account.startsWith('qq:') ? 'qq' : 'weixin', r.user) })); }
  emit(session, call, text = '', image = null, recipient) {
    const c = this.context(session); if (!c) throw new BridgeError('outbound-context-required');
    const contact = c.kind === 'test' ? null : recipient
      ? this.db.prepare('SELECT * FROM contacts WHERE id=?').get(recipient)
      : c.contact ? this.db.prepare('SELECT * FROM contacts WHERE id=?').get(c.contact)
        : this.db.prepare('SELECT * FROM contacts ORDER BY CASE WHEN job=? THEN 0 ELSE 1 END,updated DESC LIMIT 1').get(c.job);
    if (c.kind !== 'test' && !contact) throw new BridgeError('known-contact-required');
    if (typeof text !== 'string' || text.length > 16000 || clean(text, 16000) !== text || (!text.trim() && !image)) throw new BridgeError('outbound-invalid');
    if (image && !this.db.prepare('SELECT 1 FROM images WHERE id=?').get(image)) throw new BridgeError('image-not-found');
    if (image && c.kind === 'test') throw new BridgeError('test-image-library-isolated');
    if (image && contact?.account.startsWith('qq:')) throw new BridgeError('qq-text-only');
    const id = session + ':' + c.job + ':' + call;
    this.db.prepare('INSERT OR IGNORE INTO emissions(id,session,job,text,image,created,delivery_job) VALUES(?,?,?,?,?,?,?)').run(id, session, c.job, text, image, Date.now(), contact?.job ?? null);
    return { id, state: 'queued', meaning: c.kind === 'test' ? '仅进入独立测试记录，不发送微信' : '持久排队，尚不代表微信已送达' };
  }
  record(session, event) {
    const c = this.context(session); if (!c) return;
    const d = event.data ?? {}, at = typeof event.time === 'number' && event.time > 100000000000 ? event.time : Date.now();
    const put = (kind, text) => { if (text) this.db.prepare('INSERT OR IGNORE INTO private_records(session,seq,kind,text,created) VALUES(?,?,?,?,?)').run(session, event.seq, kind, clean(text, Number.MAX_SAFE_INTEGER), at); };
    const route = this.db.prepare('SELECT * FROM reply_routes WHERE job=?').get(c.job);
    if (event.type === 'user/message' && route && d.source?.rpcId === route.request) this.db.prepare('UPDATE reply_routes SET start_seq=COALESCE(start_seq,?) WHERE job=?').run(event.seq, c.job);
    if (event.type === 'user/message' && d.source?.kind === 'friend-continuation' && route && !route.closed && route.start_seq !== null && event.seq > route.start_seq) this.finishReply(session);
    if (event.type === 'tool/call' && d.name === 'private_note') {
      try {
        const note = JSON.parse(d.arguments).text;
        if (typeof note === 'string' && note.length <= 16000 && clean(note, 16000) === note) {
          put('note', note);
          if (route && !route.closed && route.start_seq !== null && event.seq > route.start_seq) this.db.prepare('UPDATE reply_routes SET is_private=1 WHERE job=?').run(c.job);
        }
      } catch { /* malformed tool arguments are rejected by DSH */ }
    }
    if (event.type === 'assistant/message') {
      put('reasoning', (d.message?.content ?? []).filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('\n'));
      const text = (d.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
      if (text && route && !route.closed && !route.is_private && route.start_seq !== null && event.seq > route.start_seq && !this.db.prepare('SELECT 1 FROM emissions WHERE job=?').get(c.job)) {
        this.db.prepare('INSERT OR IGNORE INTO reply_candidates VALUES(?,?,?)').run(c.job, event.seq, clean(text, Number.MAX_SAFE_INTEGER));
      } else if (!this.db.prepare('SELECT 1 FROM reply_candidates WHERE job=? AND seq=?').get(c.job, event.seq)) put('note', text);
      if (d.usage) put('usage', JSON.stringify(d.usage));
    }
    if (event.type === 'system/message') put('prompt', typeof d.message?.content === 'string' ? d.message.content : JSON.stringify(d));
  }
  thoughts(session, before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare("SELECT * FROM private_records WHERE session=? AND n<? AND kind!='prompt' ORDER BY n DESC LIMIT 30").all(session, Number.isSafeInteger(before) ? before : Number.MAX_SAFE_INTEGER);
    const selected = []; let bytes = 0;
    for (const r of rows) { const size = Buffer.byteLength(JSON.stringify(r)); if (selected.length && bytes + size > 750000) break; selected.push(r); bytes += size; }
    return { entries: selected.reverse(), hasMore: Boolean(selected.length && this.db.prepare("SELECT 1 FROM private_records WHERE session=? AND n<? AND kind!='prompt'").get(session, selected[0].n)) };
  }
  alarm(session, call, due, note = '') {
    if (!this.context(session) || typeof note !== 'string' || note.length > 1000 || clean(note, 1000) !== note) throw new BridgeError('alarm-invalid');
    const time = Date.parse(due); if (typeof due !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(due) || !Number.isFinite(time) || time < Date.now() + 1000) throw new BridgeError('alarm-time-invalid');
    const id = session + ':' + this.context(session).job + ':' + call;
    this.db.prepare('INSERT OR IGNORE INTO alarms(id,session,due,note,created) VALUES(?,?,?,?,?)').run(id, session, time, note, Date.now());
    return { id, due: new Date(time).toISOString(), note };
  }
  alarms(session) { return this.db.prepare('SELECT * FROM alarms WHERE session=? ORDER BY due DESC LIMIT 100').all(session); }
  cancelAlarm(session, id) { return { changed: this.db.prepare("UPDATE alarms SET state='cancelled' WHERE session=? AND id=? AND state='scheduled'").run(session, id).changes }; }
  clearTest(session) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM reply_candidates WHERE job IN (SELECT job FROM reply_routes WHERE session=?)').run(session); for (const table of ['reply_routes', 'contexts', 'emissions', 'private_records', 'alarms']) this.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(session); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  promptView(session, kind) {
    const test = kind === 'test' || this.context(session)?.kind === 'test';
    const dir = path.join(this.dir, test ? 'testing/cognitive' : 'cognitive');
    let self = null;
    const file = path.join(dir, 'cognitive.sqlite');
    if (fs.existsSync(file)) { const db = new DatabaseSync(file, { readOnly: true }); try { const row = db.prepare('SELECT v.model,v.version FROM self_versions v JOIN scopes s ON s.id=v.scope AND s.version=v.version LIMIT 1').get(); if (row) self = { version: row.version, model: JSON.parse(row.model) }; } finally { db.close(); } }
    return { core: fs.readFileSync(path.join(root, 'cognitive/CORE.md'), 'utf8'), self,
      previousCore: fs.readFileSync(path.join(root, 'cognitive/bootstrap/pre-1.3.0/CORE.md'), 'utf8'),
      assembled: typeof session === 'string' ? this.db.prepare("SELECT text,created FROM private_records WHERE session=? AND kind='prompt' ORDER BY n DESC LIMIT 1").get(session) ?? null : null,
      room: path.join(dir, 'room'), model: FLASH };
  }
}
