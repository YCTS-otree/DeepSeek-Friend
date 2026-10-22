import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { randomUUID } from 'node:crypto';

export const account = { accountId: 'bot-test', ownerId: 'alice' };
export function incoming(text = '你好', id = randomUUID(), user = 'alice', extra = {}) {
  return { message_id: id, from_user_id: user, to_user_id: 'bot-test', message_type: 1, message_state: 2,
    context_token: 'fake-context', run_id: 'run-test', item_list: [{ type: 1, text_item: { text } }], ...extra };
}
export class FakeDsh extends EventEmitter {
  constructor() { super(); this.calls = []; this.clientId = 'client-test'; this.follows = new Set(); }
  async rpc(endpoint, args) {
    this.calls.push({ endpoint, args });
    if (endpoint === 'session/create') return { sessionId: args.sessionId, agentPreset: 'weixin' };
    if (endpoint === 'session/projections') return { asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } };
    return { accepted: true };
  }
  follow(id) { this.follows.add(id); }
  unfollow(id) { this.follows.delete(id); }
  async result(pending, value) { this.calls.push({ endpoint: '$events/result', pending, value }); }
  holdQuestion() {}
  releaseQuestion() {}
}
export function fixture(t, { allowApprovals = false } = {}) {
  const config = loadConfig('config.example.json', {}); config.bridge.allowApprovals = allowApprovals;
  config.cognitive.enabled = false; // Cognitive behavior has isolated fixtures; bridge regressions never touch real memory.
  config.interaction.enabled = false; // Legacy transport regressions retain aggregate delivery; runtime has separate tests.
  config.media.enabled = false;
  const dir = path.resolve('.research/test-state'); fs.mkdirSync(dir, { recursive: true });
  config.dsh.cwd = path.join(dir, 'workspaces');
  const file = path.join(dir, randomUUID() + '.sqlite'); const store = new Store(file);
  const dsh = new FakeDsh(); const abort = new AbortController();
  const ilink = { send: async () => ({ message_id: 'server-id' }) };
  const engine = new Engine(config, store, dsh, ilink, account, abort.signal);
  t.after(async () => { abort.abort(); await engine.drain(); store.close(); });
  function ingest(...messages) { store.ingest(account.accountId, { msgs: messages, get_updates_buf: 'next-cursor' }, new Set(['alice', 'bob']), 16_000); }
  function job(id) { return store.db.prepare('SELECT * FROM jobs WHERE message_id=?').get(id); }
  return { config, store, dsh, abort, ilink, engine, ingest, job, file };
}
export function event(seq, type, data) { return { type: 'event', event: { seq, type, data, time: 1 } }; }
export function turn(requestId, text = '你好，我是 DSH。', n = 1, base = 0) {
  return [event(base, 'turn/start', { turn: n }), event(base + 1, 'user/message', { source: { kind: 'user', rpcId: requestId } }),
    event(base + 2, 'assistant/message', { turn: n, step: 1, message: { content: [{ type: 'reasoning', text: 'SECRET-THOUGHT' }, { type: 'text', text }] }, stream: [{ text: 'SECRET-STREAM' }] }),
    event(base + 3, 'turn/end', { turn: n, reason: { kind: 'completed' } })];
}
