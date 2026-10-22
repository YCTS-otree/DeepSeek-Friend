import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, backoff, sleep, log } from './util.js';

export const isCommand = text => /^\/(?:approve|deny|answer|cancel|reset|status)(?:\s|$)/.test(text.trim());
export function publicEvent(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'turn/start': return { turn: d.turn };
    case 'turn/end': return { turn: d.turn, reason: { kind: d.reason?.kind } };
    case 'user/message': return { source: { kind: d.source?.kind, rpcId: d.source?.rpcId } };
    case 'assistant/message': return { turn: d.turn, text: (d.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n') };
    case 'tool/call': return { turn: d.turn, callId: d.callId, name: d.name, arguments: d.arguments };
    case 'approval/asked': return { id: d.id, callId: d.callId, toolName: d.toolName, reason: d.reason };
    case 'approval/decided': return { id: d.id, outcome: d.outcome };
    default: return null;
  }
}
export function answerValue(request, value) {
  const questions = request.questions;
  let answers;
  if (value.trim().startsWith('[')) {
    try { answers = JSON.parse(value); } catch { throw new BridgeError('answer-json'); }
  } else if (questions?.length === 1) answers = [{ id: questions[0].id, selected: [], custom: value.trim() }];
  else throw new BridgeError('answer-batch-required');
  if (!Array.isArray(answers) || answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length) throw new BridgeError('answer-invalid');
  for (const q of questions) {
    const a = answers.find(x => x.id === q.id);
    if (!a || !Array.isArray(a.selected) || a.selected.some(s => typeof s !== 'string' || !(q.options ?? []).some(o => o.label === s))
      || (!q.multiSelect && a.selected.length > 1) || (a.custom !== undefined && typeof a.custom !== 'string')
      || (a.selected.length === 0 && !a.custom?.trim())) throw new BridgeError('answer-invalid');
  }
  return { answers: answers.map(a => ({ id: a.id, selected: a.selected, ...(a.custom ? { custom: a.custom } : {}) })) };
}
export class Engine {
  constructor(config, store, dsh, ilink, account, signal) {
    Object.assign(this, { config, store, dsh, ilink, account, signal });
    this.controller = new AbortController(); this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.busy = new Map(); this.chains = new Map(); this.pendingTasks = new Set(); this.stopped = false;
    dsh.on('session', (sid, frame) => this.enqueueSession(sid, frame));
    dsh.on('request', request => this.task(() => this.onRequest(request)));
    dsh.on('cancelRequest', frame => store.db.prepare("UPDATE pending SET state='stale' WHERE event_id=?").run(frame.eventId));
    dsh.on('disconnected', () => { store.db.prepare("UPDATE pending SET state='stale' WHERE state='pending'").run(); });
    dsh.on('missing', sid => { const job = store.active(sid); if (job?.account === account.accountId) store.updateJob(job.id, 'review', 'session/not-found'); });
    dsh.on('diagnostic', code => log('dsh.connection', { code }));
    dsh.on('remote', frame => {
      if (frame.event === 'api-session/error') {
        const job = store.active(frame.args?.[0]);
        if (job?.account === account.accountId) { store.updateJob(job.id, 'review', 'dsh-agent-error'); store.reply(job, 'DSH Agent 发生异常。请使用 /status 查看，或 /cancel 停止后重试。', 'agent-error:' + job.id); }
      }
    });
  }
  task(fn) {
    const p = Promise.resolve().then(fn).catch(e => { log('bridge.task', { code: e.code ?? 'internal' }); });
    this.pendingTasks.add(p); p.finally(() => this.pendingTasks.delete(p)); return p;
  }
  enqueueSession(sid, frame) {
    const prev = this.chains.get(sid) ?? Promise.resolve();
    const next = prev.then(() => this.onSession(sid, frame)).catch(e => {
      log('dsh.reconcile', { code: e.code ?? 'reconcile-error' });
      const job = this.store.active(sid); if (job) this.store.updateJob(job.id, 'review', e.code ?? 'reconcile-error');
    });
    this.chains.set(sid, next); next.finally(() => { if (this.chains.get(sid) === next) this.chains.delete(sid); });
    return next;
  }
  async onSession(sid, frame) {
    const mapping = this.store.db.prepare('SELECT * FROM conversations WHERE session=?').get(sid);
    if (!mapping || mapping.account !== this.account.accountId) return;
    let records;
    if (frame.type === 'snapshot') {
      records = [...frame.records ?? []]; let more = frame.hasMore;
      while (more && (!records.length || records[0].event.seq > mapping.cursor + 1)) {
        if (!records.length) throw new BridgeError('dsh-history-gap');
        const beforeSeq = records[0].event.seq;
        const page = await this.dsh.rpc('session/page', { address: { kind: 'session', sessionId: sid }, throughSeq: frame.cursor, beforeSeq, maxMessages: 200 }, this.signal);
        if (!page.records?.length || page.records[0].event.seq >= beforeSeq) throw new BridgeError('dsh-history-gap');
        records = [...page.records, ...records]; more = page.hasMore;
      }
    } else if (frame.type === 'event') records = [frame];
    else return; // Ignore ephemeral token streams, reasoning and unknown presentation frames.
    this.store.tx(() => {
      let cursor = mapping.cursor;
      for (const entry of records) {
        const event = entry.event;
        if (!Number.isSafeInteger(event?.seq) || event.seq < 0) throw new BridgeError('dsh-event-invalid');
        if (event.seq <= cursor) continue;
        if (cursor >= 0 && event.seq !== cursor + 1) throw new BridgeError('dsh-event-gap');
        const data = publicEvent(event);
        if (data) this.store.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(sid, event.seq, event.type, JSON.stringify(data));
        cursor = event.seq;
      }
      if (frame.type === 'snapshot' && cursor < frame.cursor) throw new BridgeError('dsh-snapshot-incomplete');
      this.store.db.prepare('UPDATE conversations SET cursor=? WHERE session=?').run(cursor, sid);
      this.finish(sid);
    });
  }
  finish(sid) {
    const job = this.store.active(sid); if (!job) return;
    const events = this.store.db.prepare('SELECT * FROM events WHERE session=? ORDER BY seq').all(sid).map(e => ({ ...e, data: JSON.parse(e.data) }));
    const user = events.find(e => e.type === 'user/message' && e.data.source?.rpcId === job.request_id);
    if (!user) return;
    const start = events.filter(e => e.type === 'turn/start' && e.seq < user.seq).at(-1);
    if (!start) throw new BridgeError('dsh-turn-missing');
    const turn = start.data.turn;
    this.store.db.prepare('UPDATE jobs SET turn=? WHERE id=?').run(turn, job.id);
    const end = events.find(e => e.type === 'turn/end' && e.data.turn === turn && e.seq > user.seq);
    if (!end) return;
    const texts = events.filter(e => e.type === 'assistant/message' && e.data.turn === turn && e.seq > user.seq && e.seq < end.seq).map(e => e.data.text).filter(Boolean);
    const reason = end.data.reason?.kind;
    let text = texts.join('\n\n');
    if (reason !== 'completed') text = 'DSH 本轮未正常完成（' + (['aborted', 'blocked', 'interrupted', 'error', 'failed'].includes(reason) ? reason : 'unknown') + '）。' + (text ? '\n\n' + text : '');
    if (!text) text = 'DSH 已结束本轮，未产生可发送的文本。';
    this.store.reply(job, text, 'result:' + job.id, this.config.bridge.maxReplyChars);
    this.store.updateJob(job.id, 'done');
  }
  async submit(job) {
    const mapping = this.store.ensureMapping(job.account, job.user);
    const session = mapping.session;
    this.store.db.prepare("UPDATE jobs SET session=?,state='submitting',attempts=attempts+1,updated=? WHERE id=?").run(session, Date.now(), job.id);
    try {
      const cwd = path.join(this.config.dsh.cwd, createHash('sha256').update(JSON.stringify([job.account, job.user])).digest('hex').slice(0, 32));
      fs.mkdirSync(cwd, { recursive: true });
      await this.dsh.rpc('session/create', { sessionId: session, cwd, agentPreset: this.config.dsh.agentPreset }, this.signal);
      this.dsh.follow(session);
      await this.dsh.rpc('session/prompt', { sessionId: session, requestId: job.request_id, mode: 'queue',
        content: [{ type: 'text', text: JSON.parse(job.payload).text }], clientTimeZone: 'Asia/Shanghai' }, this.signal);
      // A very fast Agent may have already completed while the RPC acknowledgement travelled.
      if (this.store.job(job.id).state === 'submitting') this.store.updateJob(job.id, 'waiting');
    } catch (e) {
      const current = this.store.job(job.id);
      if (current.state === 'done') return;
      // Persisted requestId + explicit session identity make a later admission retry bounded to the same request.
      if (e.retryable) this.store.updateJob(job.id, 'submitting', e.code, Date.now() + backoff(job.attempts));
      else { this.store.updateJob(job.id, 'review', e.code ?? 'dsh-submit'); this.store.reply(job, 'DSH 暂未接受或确认此消息。请在本地检查状态；不会自动创建替代会话。', 'submit-error:' + job.id); }
    }
  }
  approvalBinding(pending) {
    const request = JSON.parse(pending.request);
    if (!request.callId || !request.toolName || !request._bridgeAuditId) return null;
    const rows = this.store.db.prepare('SELECT type,data FROM events WHERE session=? ORDER BY seq').all(pending.session).map(r => ({ type: r.type, data: JSON.parse(r.data) }));
    const asked = rows.find(r => r.type === 'approval/asked' && r.data.id === request._bridgeAuditId && r.data.callId === request.callId && r.data.toolName === request.toolName && r.data.reason === request.reason);
    const call = rows.filter(r => r.type === 'tool/call' && r.data.callId === request.callId && r.data.name === request.toolName).at(-1);
    if (!asked || !call || rows.some(r => r.type === 'approval/decided' && r.data.id === asked.data.id)) return null;
    if (typeof call.data.arguments !== 'string' || call.data.arguments.length > 2000) return null;
    return call.data;
  }
  approvalAudit(session, request, eventId) {
    const rows = this.store.db.prepare('SELECT type,data FROM events WHERE session=? ORDER BY seq').all(session).map(r => ({ type: r.type, data: JSON.parse(r.data) }));
    const undecided = rows.filter(r => r.type === 'approval/asked' && r.data.callId === request.callId && r.data.toolName === request.toolName && r.data.reason === request.reason
      && !rows.some(d => d.type === 'approval/decided' && d.data.id === r.data.id));
    if (undecided.length !== 1) return null;
    const id = undecided[0].data.id;
    const reserved = this.store.db.prepare('SELECT event_id,request FROM pending WHERE session=?').all(session)
      .some(p => p.event_id !== eventId && JSON.parse(p.request)._bridgeAuditId === id);
    return reserved ? null : id;
  }
  async onRequest(frame) {
    const mapping = this.store.db.prepare('SELECT * FROM conversations WHERE session=?').get(frame.agentId);
    const job = this.store.active(frame.agentId);
    if (!mapping || mapping.account !== this.account.accountId || !job || frame.clientId !== this.dsh.clientId) return;
    if (!['approval/request', 'user-questions/request'].includes(frame.event)) return;
    await (this.chains.get(frame.agentId) ?? Promise.resolve());
    const kind = frame.event === 'approval/request' ? 'approval' : 'question';
    const existing = this.store.db.prepare('SELECT * FROM pending WHERE session=? AND event_id=?').get(frame.agentId, frame.eventId);
    const id = existing?.id ?? randomUUID().slice(0, 12);
    const expires = existing?.expires ?? Date.now() + this.config.bridge.approvalTimeoutMs;
    const request = { ...frame.request };
    // Pin the sole undecided DSH audit ID now. Never choose a later audit on approval.
    if (kind === 'approval') request._bridgeAuditId = this.approvalAudit(frame.agentId, request, frame.eventId);
    this.store.db.prepare(`INSERT INTO pending(id,session,account,user,event_id,client_id,kind,request,expires) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session,event_id) DO UPDATE SET client_id=excluded.client_id,state=CASE WHEN pending.state IN ('done','unknown') THEN pending.state ELSE 'pending' END`)
      .run(id, frame.agentId, mapping.account, mapping.user, frame.eventId, frame.clientId, kind, JSON.stringify(request), expires);
    const pending = this.store.db.prepare('SELECT * FROM pending WHERE id=?').get(id);
    if (pending.state !== 'pending') return;
    if (kind === 'approval') {
      const binding = this.approvalBinding(pending);
      if (!this.config.bridge.allowApprovals || !binding) {
        this.store.db.prepare("UPDATE pending SET state='answering' WHERE id=?").run(id);
        await this.dsh.result(pending, 'rejected', this.signal);
        this.store.db.prepare("UPDATE pending SET state='done' WHERE id=?").run(id);
        this.store.reply(job, 'DSH 工具操作已拒绝：微信审批未启用，或无法核验具体操作。', 'denied:' + id); return;
      }
      this.store.reply(job, `DSH 请求单次工具权限 [${id}]\n工具：${binding.name}\n参数（来自 DSH 调用记录）：${binding.arguments}\n输入 /approve ${id} 或 /deny ${id}。仅本次有效。`, 'prompt:' + id);
    } else {
      const questions = frame.request?.questions;
      if (!Array.isArray(questions) || !questions.length || questions.some(q => typeof q.id !== 'string' || typeof q.question !== 'string')) throw new BridgeError('dsh-question-invalid');
      if (frame.request.wait?.timed) this.dsh.holdQuestion(frame.agentId, frame.request.wait.callId, id);
      const text = questions.map(q => `[${q.id}] ${q.question}${q.detail ? '\n' + q.detail : ''}${q.options?.length ? '\n选项：' + q.options.map(o => o.label).join(' / ') : ''}`).join('\n\n');
      this.store.reply(job, `DSH 提问 [${id}]\n${text}\n${questions.length === 1 ? `回复 /answer ${id} 你的答案` : `回复 /answer ${id} [{"id":"问题ID","selected":[],"custom":"答案"},...]`}`, 'prompt:' + id);
    }
  }
  async command(job) {
    const text = JSON.parse(job.payload).text.trim(); const [cmd, id] = text.split(/\s+/);
    const map = this.store.mapping(job.account, job.user);
    let reply = '命令未执行。';
    if (cmd === '/status') {
      const active = map && this.store.active(map.session);
      const requests = map ? this.store.db.prepare("SELECT id,kind FROM pending WHERE session=? AND state='pending'").all(map.session) : [];
      reply = `当前任务：${active?.state ?? 'idle'}；排队：${this.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE account=? AND user=? AND state IN ('queued','backoff')").get(job.account, job.user).n}；待答复：${requests.map(p => p.kind + ':' + p.id).join(',') || '无'}`;
    } else if (cmd === '/cancel' || cmd === '/reset') {
      if (map) {
        // cancel alone preserves DSH's inbox; explicitly remove queued items before cancelling.
        const p = await this.dsh.rpc('session/projections', { sessionId: map.session }, this.signal);
        const inbox = p?.values?.inbox;
        if (inbox !== undefined) {
          if (!inbox || typeof inbox !== 'object' || ['next-turn', 'next-step'].some(k => !Array.isArray(inbox[k]))) throw new BridgeError('dsh-inbox-invalid');
          for (const item of [...inbox['next-turn'], ...inbox['next-step']]) {
            if (typeof item.id !== 'string') throw new BridgeError('dsh-inbox-item-invalid');
            try { await this.dsh.rpc('session/updateQueue', { sessionId: map.session, itemId: item.id, action: { kind: 'remove' } }, this.signal); }
            catch (e) { if (e.code !== 'session/queue-item-not-found') throw e; }
          }
        }
        try { await this.dsh.rpc('session/cancel', { sessionId: map.session }, this.signal); }
        catch (e) { if (e.code !== 'session/not-found') throw e; }
      }
      this.store.tx(() => {
        this.store.db.prepare("UPDATE jobs SET state='done',error='user-cancelled' WHERE account=? AND user=? AND id!=? AND state IN ('queued','backoff','submitting','waiting','review')").run(job.account, job.user, job.id);
        if (map) this.store.db.prepare("UPDATE pending SET state='stale' WHERE session=?").run(map.session);
        if (cmd === '/reset') this.store.db.prepare('DELETE FROM conversations WHERE account=? AND user=?').run(job.account, job.user);
      });
      if (cmd === '/reset' && map) this.dsh.unfollow?.(map.session);
      reply = cmd === '/reset' ? '会话映射已清理，下条消息将创建新的 DSH Session。原 DSH 历史保留。' : '已请求取消 DSH 任务并清理本会话排队消息。';
    } else {
      const p = this.store.db.prepare("SELECT * FROM pending WHERE id=? AND account=? AND user=? AND state='pending'").get(id ?? '', job.account, job.user);
      if (!p || !map || p.session !== map.session || p.expires <= Date.now() || p.client_id !== this.dsh.clientId) throw new BridgeError('pending-stale-or-foreign');
      let value;
      if (p.kind === 'approval' && ['/approve', '/deny'].includes(cmd)) {
        if (cmd === '/approve' && (!this.config.bridge.allowApprovals || !this.approvalBinding(p))) throw new BridgeError('approval-binding-invalid');
        if (cmd === '/approve') {
          const prompts = this.store.db.prepare("SELECT state FROM outbox WHERE id LIKE ?").all('prompt:' + p.id + ':%');
          if (!prompts.length || prompts.some(row => row.state !== 'sent')) throw new BridgeError('approval-display-unconfirmed');
        }
        value = cmd === '/approve' ? 'allowed-once' : 'rejected';
      } else if (p.kind === 'question' && cmd === '/answer') value = answerValue(JSON.parse(p.request), text.slice(text.indexOf(id) + id.length).trim());
      else throw new BridgeError('pending-kind-mismatch');
      this.store.db.prepare("UPDATE pending SET state='answering' WHERE id=?").run(id);
      try {
        await this.dsh.result(p, value, this.signal);
        this.store.db.prepare("UPDATE pending SET state='done' WHERE id=?").run(id);
        this.dsh.releaseQuestion?.(id); reply = '答复已提交 DSH。';
      } catch (e) { this.store.db.prepare("UPDATE pending SET state='unknown' WHERE id=?").run(id); throw e; }
    }
    this.store.tx(() => { this.store.reply(job, reply, 'command:' + job.id); this.store.updateJob(job.id, 'done'); });
  }
  async tick() {
    const now = Date.now();
    for (const p of this.store.db.prepare("SELECT * FROM pending WHERE account=? AND state='pending' AND expires<=?").all(this.account.accountId, now)) {
      this.store.db.prepare("UPDATE pending SET state='stale' WHERE id=?").run(p.id);
      if (p.kind === 'approval' && p.client_id === this.dsh.clientId) await this.dsh.result(p, 'rejected', this.signal).catch(() => {});
      this.dsh.releaseQuestion?.(p.id);
    }
    for (const j of this.store.db.prepare("SELECT * FROM jobs WHERE account=? AND state='waiting' AND updated<?").all(this.account.accountId, now - this.config.dsh.turnTimeoutMs)) {
      this.store.updateJob(j.id, 'review', 'turn-timeout');
      await this.dsh.rpc('session/cancel', { sessionId: j.session }, this.signal).catch(() => {});
      this.store.reply(j, 'DSH 响应超时，已请求取消。任务保留以供核对；使用 /status 或 /cancel。', 'timeout:' + j.id);
    }
    const jobs = this.store.db.prepare("SELECT * FROM jobs WHERE account=? AND state IN ('queued','backoff','submitting') AND retry_at<=? ORDER BY created,rowid").all(this.account.accountId, now);
    // Controls may be handled while a turn waits, but remain serialized with prompt admission.
    jobs.sort((a, b) => Number(isCommand(JSON.parse(b.payload).text)) - Number(isCommand(JSON.parse(a.payload).text)));
    for (const job of jobs) {
      const key = JSON.stringify([job.account, job.user]);
      if (this.busy.has(key) || this.busy.size >= this.config.bridge.concurrency) continue;
      const control = isCommand(JSON.parse(job.payload).text);
      const map = this.store.mapping(job.account, job.user);
      const active = map && this.store.active(map.session);
      if (!control && active && active.id !== job.id) continue;
      const p = (control ? this.command(job) : this.submit(job)).catch(e => {
        this.store.updateJob(job.id, 'done', e.code ?? 'command-error');
        this.store.reply(job, '命令未执行或结果未确认（' + (e.code ?? 'internal') + '）。请检查 /status。', 'command-error:' + job.id);
      }).finally(() => this.busy.delete(key));
      this.busy.set(key, p);
    }
  }
  async sendOne() {
    const row = this.store.db.prepare(`SELECT o.* FROM outbox o WHERE o.account=? AND o.state='pending' AND o.retry_at<=? AND NOT EXISTS
      (SELECT 1 FROM outbox earlier WHERE earlier.account=o.account AND earlier.user=o.user AND earlier.rowid<o.rowid AND earlier.state IN ('pending','sending','unknown')) ORDER BY o.rowid LIMIT 1`).get(this.account.accountId, Date.now());
    if (!row) return false;
    this.store.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(row.id);
    try {
      const result = await this.ilink.send(JSON.parse(row.body), this.signal);
      this.store.db.prepare("UPDATE outbox SET state='sent',server_id=? WHERE id=?").run(result.message_id ?? null, row.id);
    } catch (e) {
      const state = e.ambiguous ? 'unknown' : e.retryable ? 'pending' : 'failed';
      this.store.db.prepare('UPDATE outbox SET state=?,error=?,retry_at=? WHERE id=?').run(state, e.code ?? 'send-error', Date.now() + backoff(row.attempts), row.id);
      log('weixin.send', { id: row.id, state, code: e.code });
      if (e.code === 'ilink-auth-expired') throw e;
    }
    return true;
  }
  async poll() {
    let attempt = 0;
    const allowed = new Set([this.account.ownerId, ...this.config.weixin.allowedUsers].filter(Boolean));
    while (!this.signal.aborted) {
      try {
        const response = await this.ilink.updates(this.store.get('cursor:' + this.account.accountId) ?? '', this.signal);
        this.store.ingest(this.account.accountId, response, allowed, this.config.bridge.maxTextChars);
        if (Number.isFinite(response.longpolling_timeout_ms) && response.longpolling_timeout_ms > 0) this.ilink.pollTimeout = Math.min(120_000, Math.max(1000, response.longpolling_timeout_ms));
        this.store.set('poll:' + this.account.accountId, new Date().toISOString()); attempt = 0;
        // Avoid spinning against a gateway returning empty responses immediately.
        if (!(response.msgs?.length)) await sleep(100, this.signal);
      } catch (e) {
        if (this.signal.aborted) return;
        this.store.set('last-error', e.code ?? 'poll-error'); log('weixin.poll', { code: e.code, attempt });
        if (e.code === 'ilink-auth-expired') throw e;
        await sleep(backoff(attempt++), this.signal).catch(() => {});
      }
    }
  }
  async run() {
    this.store.recover();
    for (const row of this.store.db.prepare('SELECT session FROM conversations WHERE account=?').all(this.account.accountId)) this.dsh.follow(row.session);
    const tasks = [this.dsh.run(this.signal), this.poll(), (async () => {
      while (!this.signal.aborted) { await this.tick(); await sleep(100, this.signal).catch(() => {}); }
    })(), (async () => {
      while (!this.signal.aborted) { await this.sendOne(); await sleep(200, this.signal).catch(() => {}); }
    })()];
    try { await Promise.all(tasks); }
    finally { this.stopped = true; this.controller.abort(); await Promise.allSettled(tasks); await this.drain(); }
  }
  async drain() { await Promise.allSettled([...this.busy.values(), ...this.chains.values(), ...this.pendingTasks]); }
}
