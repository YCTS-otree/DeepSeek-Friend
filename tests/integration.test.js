import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Engine } from '../src/engine.js';
import { DshClient } from '../src/dsh.js';
import { IlinkClient } from '../src/ilink.js';
import { fixture, incoming, turn, account } from './helpers.js';
import { apply } from '../dsh/weixin-policy.js';

test('complete MOCK workflow: iLink HTTP polls → DSH RPC/WS → durable reply outbox → iLink send', { timeout: 10_000 }, async t => {
  const f = fixture(t); const replies = []; const sessions = new Map(); const followed = new Map(); let poll = 0;
  const requestIds = []; const sessionIds = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/?token=fake') { res.writeHead(302, { 'set-cookie': 'dsh-auth-test=FAKE; HttpOnly' }); res.end(); return; }
    const body = JSON.parse(raw); let value;
    if (req.url === '/ilink/bot/getupdates') {
      poll++; const messages = poll === 1 ? [incoming('first', '1'), incoming('second', '2'), incoming('third', '3'), incoming('first', '1')] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ret: 0, msgs: messages, get_updates_buf: 'buf-' + poll })); return;
    }
    if (req.url === '/ilink/bot/sendmessage') {
      replies.push(body.msg); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ret: 0, message_id: 'server-' + replies.length })); return;
    }
    const args = body.payload.args.request;
    if (body.method === 'session/create') { if (!sessions.has(args.sessionId)) sessions.set(args.sessionId, []); value = { sessionId: args.sessionId }; }
    if (body.method === 'session/prompt') {
      requestIds.push(args.requestId); sessionIds.push(args.sessionId);
      const records = sessions.get(args.sessionId); const frames = turn(args.requestId, 'reply-' + requestIds.length, requestIds.length, records.length);
      records.push(...frames);
      const follow = followed.get(args.sessionId);
      if (follow) for (const frame of frames) follow.socket.send(JSON.stringify({ type: 'item', streamId: follow.id, value: frame }));
      value = { accepted: true };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.endpoint === '$events') socket.send(JSON.stringify({ type: 'item', streamId: m.streamId, value: { type: 'ready', clientId: 'client' } }));
    if (m.endpoint === 'session/follow') {
      const sid = m.payload.args.request.address.sessionId; followed.set(sid, { socket, id: m.streamId }); const records = sessions.get(sid);
      socket.send(JSON.stringify({ type: 'item', streamId: m.streamId, value: { type: 'snapshot', cursor: records.length - 1, records, hasMore: false } }));
    }
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  const dsh = new DshClient({ ...f.config.dsh, baseUrl, launchToken: 'fake', cookie: '' });
  const ilink = new IlinkClient(f.config.weixin, { botToken: 'FAKE' }, (url, options) => fetch(new URL(new URL(url).pathname, baseUrl), options));
  const engine = new Engine(f.config, f.store, dsh, ilink, account, controller.signal);
  const running = engine.run();
  try {
    const deadline = Date.now() + 7000;
    while (replies.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(replies.length, 3); assert.equal(new Set(requestIds).size, 3); assert.equal(new Set(sessionIds).size, 1);
    assert.deepEqual(replies.map(r => r.item_list[0].text_item.text), ['reply-1', 'reply-2', 'reply-3']);
    assert.ok(replies.every(r => r.context_token === 'fake-context' && r.to_user_id === 'alice'));
  } finally {
    controller.abort(); await running;
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
test('default DSH policy restricts inherited capabilities and denies attempted shell/write/MCP calls', () => {
  let restriction; let guard;
  apply({ tools: { restrict: value => { restriction = value; }, guard: check => { guard = check; } } });
  assert.deepEqual(restriction, { allow: [] });
  assert.equal(guard({ name: 'ask_user_question' }), undefined);
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'mcp__dangerous__exec', 'subagent', 'run_code', 'cordis_inspect_list']) assert.equal(typeof guard({ name }), 'string');
});
