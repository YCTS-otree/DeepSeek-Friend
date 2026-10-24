import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCognitiveBackend } from '../adapters/dsh/backend.mjs';
import { createClient } from '../adapters/dsh/client.mjs';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, PYTHONPATH: path.join(root, 'src'), PYTHONIOENCODING: 'utf-8' };
mkdirSync(path.join(root, '.cache'), { recursive: true });
const artifactRoot = process.env.MNN_TEST_ARTIFACTS || path.join(root, '.cache');
mkdirSync(artifactRoot, { recursive: true });
const directory = mkdtempSync(path.join(artifactRoot, 'adapter-'));
const scope = { agent_id: 'whale', user_id: 'synthetic-user', session_id: 'session-a', workspace_id: 'demo', visibility: 'private' };
const agent = { session: { id: scope.session_id } };
const snapshot = JSON.parse(execFileSync('python', ['-c', `
import json
from dsf_mnn import Event
from dsf_mnn.model import digest
e=Event('event-1',1,'中文参数：port=3099','2026-10-24T01:00:00Z','user_statement','synthetic://adapter/1').to_dict()
print(json.dumps({'schema':'dsf-mnn-snapshot/1','session_id':'session-a','events':[e],'digest':digest([e])}))
`], { env, encoding: 'utf8', windowsHide: true }));

class FakeBasic {
  compactRegion() {}
  compactNow() {}
  compactIfNeeded() {}
}

test('backend preserves the official transaction methods through inheritance', async () => {
  const Backend = createCognitiveBackend(FakeBasic, { resolveSnapshot: () => snapshot, prepare: async () => ({ state: 'prepared', snapshot_digest: snapshot.digest, summary: [{ type: 'text', text: 'checkpoint' }], provider: 'dsf-mnn', model: 'deterministic' }) });
  for (const method of ['compactRegion', 'compactNow', 'compactIfNeeded']) assert.equal(Backend.prototype[method], FakeBasic.prototype[method]);
  assert.equal((await new Backend().summarize({}, agent)).summary[0].text, 'checkpoint');
});

test('unbound source snapshot, mismatched prepared receipt and cancellation fail closed', async () => {
  assert.throws(() => createCognitiveBackend(FakeBasic, {}), /resolver-required/);
  const Backend = createCognitiveBackend(FakeBasic, { resolveSnapshot: () => ({ ...snapshot, session_id: 'other' }), prepare: () => { throw new Error('must not run'); } });
  await assert.rejects(new Backend().summarize({}, agent), /binding-rejected/);
  const Failed = createCognitiveBackend(FakeBasic, { resolveSnapshot: () => snapshot, prepare: () => ({ state: 'prepared', snapshot_digest: 'other' }) });
  await assert.rejects(new Failed().summarize({}, agent), /not-prepared/);
  await assert.rejects(new Failed().summarize({}, agent, AbortSignal.abort()), /abort/i);
});

test('stdio client prepares and recalls original Chinese evidence with a trusted scope', async () => {
  const client = createClient({ database: path.join(directory, 'rpc.sqlite'), resolveScope: () => scope });
  const prepared = await client('prepare', { snapshot, scope: { user_id: 'attacker' } }, agent);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.checkpoint.critical_evidence[0].content, '中文参数：port=3099');
  const result = await client('recall', { query: '中文参数', byte_budget: 2048 }, agent);
  assert.match(result.text, /port=3099/);
  assert.ok(result.bytes <= 2048);
  const other = createClient({ database: path.join(directory, 'rpc.sqlite'), resolveScope: () => ({ ...scope, user_id: 'other' }) });
  assert.equal((await other('recall', { query: '中文参数' }, agent)).text, '');
});

test('stdio client rejects scope mismatch and does not execute cancelled operations', async () => {
  const client = createClient({ database: path.join(directory, 'cancel.sqlite'), resolveScope: () => ({ ...scope, session_id: 'other' }) });
  await assert.rejects(client('status', {}, agent), /scope-mismatch/);
  await assert.rejects(client('status', {}, agent, AbortSignal.abort()), /abort/i);
});

test('installed DSH BasicCompactionEngine subclass hook works without modifying node_modules', { skip: !process.env.DSH_NODE_MODULES }, async () => {
  const modules = path.resolve(process.env.DSH_NODE_MODULES, '@deepseek-ai');
  const { BasicCompactionEngine } = await import(pathToFileURL(path.join(modules, 'dsh-compaction-basic/lib/index.js')));
  const { Context } = await import(pathToFileURL(path.join(modules, 'cordis/lib/index.js')));
  const client = createClient({ database: path.join(directory, 'actual-package.sqlite'), resolveScope: () => scope });
  const Backend = createCognitiveBackend(BasicCompactionEngine, { resolveSnapshot: () => snapshot, prepare: (s, a, signal) => client('prepare', { snapshot: s }, a, signal) });
  const context = new Context();
  const backend = new Backend(context, { auto: false });
  for (const method of ['compactRegion', 'compactNow', 'compactIfNeeded']) assert.equal(Backend.prototype[method], BasicCompactionEngine.prototype[method]);
  const result = await backend.summarize({ messages: [] }, agent);
  assert.match(result.summary[0].text, /port/);
  assert.equal(result.llmStreamCall, undefined);
});
