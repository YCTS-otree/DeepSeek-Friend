import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DshClient } from '../src/dsh.js';
import { IlinkClient, parseIlink, textMessage } from '../src/ilink.js';
import { loadConfig } from '../src/config.js';
import { login } from '../src/auth.js';
import { accountLock, dataLock } from '../src/lock.js';
import { fixture } from './helpers.js';
import { log } from '../src/util.js';

test('iLink preserves uint64 IDs and does not rewrite escaped text', () => {
  const text = '{"message_id":18446744073709551615,"text":"\\\"message_id\\\":123","item":{"msg_id":9007199254740993}}';
  const x = parseIlink(text); assert.equal(x.message_id, '18446744073709551615'); assert.equal(x.item.msg_id, '9007199254740993');
  assert.equal(x.text, '"message_id":123');
});
test('iLink sends full observed headers/base_info and text shape; getConfig/typing use official fields', async () => {
  const config = loadConfig('config.example.json', {}).weixin; const requests = [];
  const client = new IlinkClient(config, { botToken: 'FAKE-TOKEN' }, async (url, options) => {
    requests.push({ url: String(url), ...options, json: JSON.parse(options.body) });
    return Response.json({ ret: 0, typing_ticket: 'ticket', msgs: [], get_updates_buf: 'new' });
  });
  await client.updates('old'); await client.send(textMessage('alice', 'hi', 'ctx', 'stable-id', 'run'));
  await client.getConfig('alice', 'ctx'); await client.typing('alice', 'ticket', 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer FAKE-TOKEN');
  assert.equal(requests[0].headers.AuthorizationType, 'ilink_bot_token');
  assert.match(Buffer.from(requests[0].headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(requests[0].headers['iLink-App-Id'], 'bot'); assert.equal(requests[0].headers['iLink-App-ClientVersion'], String(0x02040a));
  assert.equal(requests[0].json.get_updates_buf, 'old'); assert.match(requests[0].json.base_info.bot_agent, /^DeepSeek.Friend\//);
  assert.equal(requests[1].json.msg.client_id, 'stable-id'); assert.equal(requests[2].json.context_token, 'ctx'); assert.equal(requests[3].json.typing_ticket, 'ticket');
  for (const r of requests) assert.equal(r.redirect, 'error');
});
test('iLink rejects auth failures, rate limits and malicious credential redirect targets', async () => {
  const config = loadConfig('config.example.json', {}).weixin;
  await assert.rejects(new IlinkClient(config, {}, async () => Response.json({ errcode: -14 })).updates(''), { code: 'ilink-auth-expired' });
  await assert.rejects(new IlinkClient(config, {}, async () => new Response('', { status: 429 })).updates(''), { code: 'ilink-rate-limit', retryable: true, ambiguous: false });
  assert.throws(() => new IlinkClient(config, { baseUrl: 'https://ilinkai.weixin.qq.com.evil.test' }), { code: 'ilink-host-rejected' });
  assert.throws(() => new IlinkClient(config, { baseUrl: 'https://ilinkai.weixin.qq.com:444' }));
});
test('QR login supports scan confirmation and verification code without logging tokens', async () => {
  const config = loadConfig('config.example.json', {}).weixin;
  let states = [{ status: 'need_verifycode' }, { status: 'scaned' }, { status: 'confirmed', bot_token: 'fake', ilink_bot_id: 'bot', ilink_user_id: 'alice' }];
  const urls = []; const displayed = [];
  const client = new IlinkClient(config, {}, async (url, options) => {
    urls.push(String(url));
    if (String(url).includes('get_bot_qrcode')) {
      assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { local_token_list: [] });
      return Response.json({ qrcode: 'nonce', qrcode_img_content: 'weixin://fake-login' });
    }
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.AuthorizationType, undefined);
    return Response.json(states.shift());
  });
  const result = await login(client, { display: x => displayed.push(x), verify: async () => '123456' });
  assert.equal(result.ownerId, 'alice'); assert.deepEqual(displayed, ['weixin://fake-login']);
  assert.ok(urls.some(x => x.includes('verify_code=123456'))); assert.ok(!urls.at(-1).includes('verify_code'));
});
test('expired QR refreshes; IDC redirect is restricted to explicit allowlist', async () => {
  const config = loadConfig('config.example.json', {}).weixin; let count = 0;
  const client = new IlinkClient(config, {}, async url => {
    if (String(url).includes('get_bot_qrcode')) { count++; return Response.json({ qrcode: 'qr' + count, qrcode_img_content: 'qr' }); }
    return Response.json(count === 1 ? { status: 'expired' } : { status: 'scaned_but_redirect', redirect_host: 'evil.test' });
  });
  await assert.rejects(login(client, { display() {}, verify() {} }), { code: 'ilink-host-rejected' }); assert.equal(count, 2);
});
test('QR cancellation is prompt and already-bound cannot fabricate credentials', async () => {
  const config = loadConfig('config.example.json', {}).weixin;
  const client = new IlinkClient(config, {}, async url => Response.json(String(url).includes('get_bot_qrcode') ? { qrcode: 'q', qrcode_img_content: 'q' } : { status: 'binded_redirect' }));
  await assert.rejects(login(client, { display() {} }), { code: 'already-bound-no-credentials' });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(login(client, { display() {}, signal: ac.signal }));
});
test('mock HTTP + WebSocket verifies real DSH envelopes, auth exchange and reconnect follow replay', async t => {
  const requests = []; const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(302, { 'Set-Cookie': 'dsh-auth-test=FAKE; HttpOnly; Path=/' }); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); requests.push({ message, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { presets: [{ id: 'weixin' }] } } }));
  });
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' }); let follows = 0; let connections = 0;
  wss.on('connection', socket => {
    connections++;
    socket.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.endpoint === '$events') socket.send(JSON.stringify({ type: 'item', streamId: m.streamId, value: { type: 'ready', clientId: 'client-' + connections } }));
      if (m.endpoint === 'session/follow') {
        follows++; assert.equal(m.payload.args.request.address.sessionId, 's1');
        if (follows === 1) socket.close();
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { ...loadConfig('config.example.json', {}).dsh, baseUrl: 'http://127.0.0.1:' + server.address().port, launchToken: 'fake-launch' };
  const client = new DshClient(config); const abort = new AbortController();
  t.after(async () => { abort.abort(); for (const s of wss.clients) s.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); });
  await client.check();
  assert.equal(requests[0].message.method, 'agentPresets/list'); assert.deepEqual(requests[0].message.payload, { args: {} });
  assert.equal(requests[0].cookie, 'dsh-auth-test=FAKE');
  await client.rpc('session/prompt', { sessionId: 's1', requestId: 'r1', content: [], mode: 'queue' });
  assert.equal(requests[1].message.payload.args.request.requestId, 'r1');
  client.follow('s1'); const running = client.run(abort.signal);
  const deadline = Date.now() + 5000;
  while (follows < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  abort.abort(); await running; assert.ok(follows >= 2); assert.ok(connections >= 2);
});
test('account and data directory locks reject another live instance and release cleanly', async t => {
  const f = fixture(t); const release = await accountLock('lock-test');
  await assert.rejects(accountLock('lock-test'), { code: 'account-running' }); await release();
  const second = await accountLock('lock-test'); await second();
  const dir = f.file.replace(/[^\\/]+$/, ''); const unlock = dataLock(dir);
  assert.throws(() => dataLock(dir), { code: 'instance-running' }); unlock();
});
test('default configuration targets the independent DSH and logs exclude sensitive arbitrary fields', () => {
  const config = loadConfig('config.example.json', {}); assert.equal(new URL(config.dsh.baseUrl).port, '3088');
  assert.equal(config.bridge.allowApprovals, false); assert.deepEqual(config.weixin.allowedUsers, []);
  let output = ''; const old = process.stdout.write; process.stdout.write = text => { output += text; return true; };
  try { log('test', { token: 'secret-token', cookie: 'secret-cookie', text: 'secret-text', code: 'safe' }); }
  finally { process.stdout.write = old; }
  assert.ok(!output.includes('secret')); assert.ok(output.includes('safe'));
  assert.throws(() => loadConfig('missing.json', { DSH_BASE_URL: 'http://127.0.0.1:3080' }), { code: 'working-dsh-refused' });
});
