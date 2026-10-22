import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DshClient } from '../src/dsh.js';
import { loadConfig } from '../src/config.js';
import { loadCredentials } from '../src/security.js';

test('REAL independent DSH 0.2.0-rc.2: Cookie, preset, create/adopt, projection, follow and cancel', { skip: process.env.RUN_DSH_PROTOCOL !== '1', timeout: 30_000 }, async () => {
  const c = loadConfig(); const saved = loadCredentials(c.dataDir, 'dsh-connection.json');
  const client = new DshClient({ ...c.dsh, cookie: saved.cookie });
  const controller = new AbortController(); let running;
  try {
    await client.check();
    const doc = await client.rpc('agentPresets/read', { agentPreset: 'weixin' });
    assert.match(doc.content, /dsh-tool-ask-user/); assert.doesNotMatch(doc.content, /dsh-tool-(?:pwsh|bash|fs|cordis)/);
    // Reused across separate test invocations, including an actual independent-runtime restart.
    const sessionId = 'protocol-test-persistence-v1';
    const created = await client.rpc('session/create', { sessionId, cwd: c.dsh.cwd, agentPreset: 'weixin' }); assert.equal(created.sessionId, sessionId);
    const adopted = await client.rpc('session/create', { sessionId, cwd: c.dsh.cwd, agentPreset: 'weixin' }); assert.equal(adopted.sessionId, sessionId);
    const projections = await client.rpc('session/projections', { sessionId }); assert.ok(Number.isInteger(projections.asOfSeq)); assert.equal(projections.values.agentPreset, 'weixin');
    assert.deepEqual(Object.keys(projections.values.inbox).sort(), ['next-step', 'next-turn']);
    const snapshot = new Promise(resolve => client.on('session', (sid, frame) => { if (sid === sessionId && frame.type === 'snapshot') resolve(frame); }));
    client.follow(sessionId); const ready = once(client, 'connected'); running = client.run(controller.signal); await ready;
    const s = await snapshot; assert.ok(Number.isInteger(s.cursor)); assert.ok(Array.isArray(s.records));
    await client.rpc('session/cancel', { sessionId });
    assert.equal(await client.rpc('session/projections', { sessionId: 'absent-' + randomUUID() }), null);
  } finally { controller.abort(); if (running) await running; }
});
