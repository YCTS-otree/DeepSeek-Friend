import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, incoming, event } from './helpers.js';
import { Store } from '../src/store.js';
import { profileArguments } from '../scripts/runtime-options.js';
import { secureDirectory, saveCredentials, loadCredentials } from '../src/security.js';
import { BridgeError } from '../src/util.js';

test('actual abrupt process exit rolls back an uncommitted SQLite inbox/cursor transaction', t => {
  const f = fixture(t);
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('crash-cursor','UNCOMMITTED'); process.exit(73);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.file], { windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 73);
  const reopened = new Store(f.file); assert.equal(reopened.get('crash-cursor'), undefined); reopened.close();
});
test('submitting task, mapping and request identity survive process-like reopen', async t => {
  const f = fixture(t); f.ingest(incoming('before restart', 'restart'));
  const rpc = f.dsh.rpc.bind(f.dsh);
  f.dsh.rpc = async (endpoint, args) => { await rpc(endpoint, args); throw new BridgeError('dsh-network', '', { retryable: true }); };
  await f.engine.submit(f.job('restart'));
  const before = f.job('restart'); const reopened = new Store(f.file); reopened.recover();
  const after = reopened.job(before.id); assert.equal(after.session, before.session); assert.equal(after.request_id, before.request_id);
  assert.equal(after.state, 'submitting'); reopened.close();
});
test('Windows DPAPI or Linux private-file credential roundtrip never writes plaintext on Windows', t => {
  const f = fixture(t); const dir = path.join(path.dirname(f.file), path.basename(f.file) + '-private');
  secureDirectory(dir); const fake = { botToken: 'FAKE-TEST-NOT-A-SECRET', accountId: 'test' };
  saveCredentials(dir, fake); assert.deepEqual(loadCredentials(dir), fake);
  if (process.platform === 'win32') assert.ok(!fs.readFileSync(path.join(dir, 'weixin-credentials.json'), 'utf8').includes(fake.botToken));
  else assert.equal(fs.statSync(path.join(dir, 'weixin-credentials.json')).mode & 0o077, 0);
});
test('independent profile creation flags are used once; restart preserves existing configuration', t => {
  const f = fixture(t); const home = path.join(path.dirname(f.file), path.basename(f.file) + '-home');
  assert.deepEqual(profileArguments(home), ['--profile', 'weixin', '--from-default-profile', 'web']);
  fs.mkdirSync(path.join(home, 'profiles/weixin'), { recursive: true }); fs.writeFileSync(path.join(home, 'profiles/weixin/package.json'), '{}');
  assert.deepEqual(profileArguments(home), ['--profile', 'weixin']);
});
test('same call with two undecided approval audit IDs is ambiguous and must be rejected', async t => {
  const f = fixture(t, { allowApprovals: true }); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  for (const e of [event(0, 'turn/start', { turn: 1 }), event(1, 'tool/call', { callId: 'call', name: 'write', arguments: '{}' }),
    event(2, 'approval/asked', { id: 'audit-1', callId: 'call', toolName: 'write' }), event(3, 'approval/asked', { id: 'audit-2', callId: 'call', toolName: 'write' })]) await f.engine.onSession(j.session, e);
  await f.engine.onRequest({ agentId: j.session, clientId: 'client-test', eventId: 'event', event: 'approval/request', request: { toolName: 'write', callId: 'call' } });
  assert.equal(f.dsh.calls.at(-1).value, 'rejected');
});
test('approval cannot be granted before complete operation display is confirmed', async t => {
  const f = fixture(t, { allowApprovals: true }); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  for (const e of [event(0, 'turn/start', { turn: 1 }), event(1, 'tool/call', { callId: 'call', name: 'write', arguments: '{}' }),
    event(2, 'approval/asked', { id: 'audit-1', callId: 'call', toolName: 'write' })]) await f.engine.onSession(j.session, e);
  await f.engine.onRequest({ agentId: j.session, clientId: 'client-test', eventId: 'event', event: 'approval/request', request: { toolName: 'write', callId: 'call' } });
  const pending = f.store.db.prepare('SELECT * FROM pending').get();
  f.ingest(incoming('/approve ' + pending.id, 'approve'));
  await assert.rejects(f.engine.command(f.job('approve')), { code: 'approval-display-unconfirmed' });
  assert.equal(f.dsh.calls.filter(c => c.endpoint === '$events/result').length, 0);
});
test('reset of an explicitly missing DSH session is controlled and creates no hidden replacement', async t => {
  const f = fixture(t); f.ingest(incoming('a', 'a')); await f.engine.submit(f.job('a')); const j = f.job('a');
  f.dsh.emit('missing', j.session); assert.equal(f.job('a').state, 'review');
  f.dsh.rpc = async endpoint => { if (endpoint === 'session/projections') return null; throw new BridgeError('session/not-found'); };
  f.ingest(incoming('/reset', 'reset')); await f.engine.command(f.job('reset'));
  assert.equal(f.store.mapping('bot-test', 'alice'), undefined); assert.equal(f.job('a').state, 'done');
});
test('inbound NEW state is accepted and generating fragments cannot advance into Agent jobs', t => {
  const f = fixture(t); f.ingest(incoming('new', 'new', 'alice', { message_state: 0 }), incoming('partial', 'partial', 'alice', { message_state: 1 }));
  assert.ok(f.job('new')); assert.equal(f.job('partial'), undefined);
});
test('changing the active Weixin account cannot execute an old account queue or answer its requests', async t => {
  const f = fixture(t);
  f.store.ingest('old-bot', { msgs: [incoming('old-account-private-text', 'old')], get_updates_buf: 'old' }, new Set(['alice']), 16_000);
  f.ingest(incoming('current', 'current'));
  await f.engine.tick(); await f.engine.drain();
  assert.equal(f.job('old').state, 'queued');
  assert.equal(f.dsh.calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  assert.equal(f.dsh.calls.find(c => c.endpoint === 'session/prompt').args.content[0].text, 'current');
});
test('reset releases the old follow subscription', async t => {
  const f = fixture(t); f.ingest(incoming('hello', 'hi')); await f.engine.submit(f.job('hi'));
  const sid = f.job('hi').session; assert.ok(f.dsh.follows.has(sid));
  f.ingest(incoming('/reset', 'reset')); await f.engine.command(f.job('reset')); assert.ok(!f.dsh.follows.has(sid));
});
