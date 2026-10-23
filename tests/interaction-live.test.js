import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadCredentials } from '../src/security.js';
import { DshClient } from '../src/dsh.js';
import { CognitiveStore } from '../src/cognitive/store.js';
import { RuntimeStore } from '../src/runtime.js';

function redPng() {
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const v of data) { crc ^= v; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const n = Buffer.alloc(4), sum = Buffer.alloc(4); n.writeUInt32BE(bytes.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([n, data, sum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(96, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (96 * 3 + 1)); for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) pixels[y * 289 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
test('REAL Flash: upgrade a tool-less legacy session, vision, multiple messages, private thoughts and continuation',
  { skip: process.env.RUN_COGNITIVE_LIVE !== '1', timeout: 180000 }, async () => {
    const c = loadConfig(process.env.COGNITIVE_LIVE_CONFIG);
    if (!c.dataDir.includes('.research') || new URL(c.dsh.baseUrl).port !== '3098') throw Error('isolated-test-required');
    const credential = loadCredentials(c.dataDir, 'dsh-connection.json'), client = new DshClient({ ...c.dsh, cookie: credential.cookie });
    const ac = new AbortController(), runtime = new RuntimeStore(c.dataDir), cognitive = new CognitiveStore(path.join(c.dataDir, 'testing/cognitive'), c.cognitive);
    const session = 'interaction-legacy-live-' + randomUUID(), scope = cognitive.scope(); cognitive.bind(scope, session, '隔离协议验收', 'conversation', { displayName: 'OTREE（合成测试）' });
    runtime.configure({ continuous: false, reasoningEffort: 'off', maxTokens: 1024, continueDelayMs: 0 });
    let running;
    async function run(text, images = [], continuation = false) {
      const requestId = randomUUID(), records = new Map(); let listener, timer;
      runtime.prepareReply(session, requestId);
      const result = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('interaction-live-timeout')), 75000);
        listener = (sid, frame) => {
          if (sid !== session) return;
          for (const row of frame.type === 'snapshot' ? frame.records ?? [] : frame.type === 'event' ? [frame] : []) records.set(row.event.seq, row.event);
          const all = [...records.values()].sort((a, b) => a.seq - b.seq), user = all.find(e => e.type === 'user/message' && e.data.source?.rpcId === requestId);
          if (!user) return;
          const start = all.filter(e => e.type === 'turn/start' && e.seq < user.seq).at(-1), events = all.filter(e => e.seq > user.seq && (e.data.turn === undefined || e.data.turn === start?.data.turn));
          if (!start) return;
          const continuationInput = events.find(e => e.type === 'user/message' && e.data.source?.kind === 'friend-continuation');
          if (continuation && continuationInput && events.some(e => e.type === 'assistant/message' && e.seq > continuationInput.seq)) resolve(events);
          const end = events.find(e => e.type === 'turn/end');
          if (end) end.data.reason?.kind === 'completed' && !continuation ? resolve(events) : reject(Error('interaction-live-incomplete:' + start.data.turn + ':' + end.data.reason?.kind + ':' + events.filter(e => e.type === 'assistant/message').length));
        }; client.on('session', listener);
      }); result.catch(() => {});
      try { await client.rpc('session/prompt', { sessionId: session, requestId, mode: 'queue', content: [{ type: 'text', text }, ...images], clientTimeZone: 'Asia/Shanghai' }); return await result; }
      finally { clearTimeout(timer); client.off('session', listener); }
    }
    try {
      const ready = once(client, 'connected'); running = client.run(ac.signal); await ready;
      await client.rpc('session/create', { sessionId: session, cwd: c.dsh.cwd, agentPreset: 'weixin-test' }); client.follow(session);
      runtime.bind(session, 'live-multi', 'test');
      await run('这是工具接口测试。请依次调用 weixin_send_message 发两条独立消息，内容分别是 LIVE_FIRST 和 LIVE_SECOND，然后调用 take_rest。不要合并消息，不要调用其他工具。');
      const messages = runtime.db.prepare("SELECT text FROM emissions WHERE job='live-multi' ORDER BY created,rowid").all();
      assert.equal(messages.length, 2); assert.equal(messages[0].text, 'LIVE_FIRST'); assert.equal(messages[1].text, 'LIVE_SECOND');
      runtime.bind(session, 'live-ordinary', 'test');
      await run('路由回归测试：请直接以普通回复正文输出 LIVE_AUTOMATIC_REPLY。不要调用发送工具或其他工具；测试已关闭持续运行。');
      assert.equal(runtime.db.prepare("SELECT text FROM emissions WHERE job='live-ordinary'").get()?.text, 'LIVE_AUTOMATIC_REPLY');
      runtime.bind(session, 'live-private-note', 'test');
      await run('只调用 private_note 保存 LIVE_PRIVATE_ONLY，再调用 take_rest。不要发送任何对外回复，也不要输出普通正文。');
      assert.equal(runtime.db.prepare("SELECT count(*) n FROM emissions WHERE job='live-private-note'").get().n, 0);
      assert.ok(runtime.thoughts(session).entries.some(e => e.kind === 'note' && e.text === 'LIVE_PRIVATE_ONLY'));
      runtime.bind(session, 'live-vision', 'test');
      await run('只根据随附图片判断：图片主要是什么颜色？用中文颜色名称调用 weixin_send_message 回答，再调用 take_rest。', [{ type: 'image', mediaType: 'image/png', data: redPng().toString('base64'), name: 'red-fixture.png' }]);
      assert.match(runtime.db.prepare("SELECT text FROM emissions WHERE job='live-vision'").get()?.text ?? '', /红/);
      runtime.bind(session, 'live-continuation', 'test'); runtime.configure({ continuous: true, reasoningEffort: 'low', maxTokens: 2048 });
      const events = await run('现在验收持续思考。请不要发送微信消息，不调用 take_rest；只用 private_note 保存很短的私有笔记，不输出普通正文。测试程序会主动停止，不需要你结束。', [], true);
      runtime.flag(session, 'rest'); runtime.configure({ continuous: false }); await client.rpc('session/cancel', { sessionId: session });
      assert.ok(events.filter(e => e.type === 'assistant/message').length >= 2);
      assert.ok(runtime.thoughts(session).entries.some(e => e.kind === 'note'));
      assert.ok(runtime.thoughts(session).entries.some(e => e.kind === 'reasoning'));
      assert.ok(events.some(e => e.type === 'user/message' && e.data.source?.kind === 'friend-continuation'));
      assert.equal(runtime.db.prepare("SELECT count(*) n FROM emissions WHERE job='live-continuation'").get().n, 0);
      console.log(JSON.stringify({ model: 'DeepSeek-V41-Flash', vision: true, multipleMessages: true, ordinaryReply: true, privateNoteIsolated: true, nativeContinuation: true, privateRecords: true }));
    } finally { runtime.flag(session, 'rest'); runtime.configure({ continuous: false }); await client.rpc('session/cancel', { sessionId: session }).catch(() => {}); ac.abort(); if (running) await running; runtime.close(); cognitive.close(); }
  });
