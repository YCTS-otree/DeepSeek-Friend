import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createNativeKernel } from '../adapters/dsh/native-kernel.mjs';
import { cognitiveEngineClass } from '../adapters/dsh/cognitive-engine.mjs';

const installed = process.env.DSH_NODE_MODULES;
const artifacts = process.env.MNN_TEST_ARTIFACTS || path.resolve('.cache');
fs.mkdirSync(artifacts, { recursive: true });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(artifacts, 'cognitive-'));
  const kernel = await createNativeKernel(installed, path.join(directory, 'sessions'));
  const { Session } = kernel.sessionModule;
  const { createSystemMessage, createUserMessage } = kernel.llmModule;
  const session = Session.create('synthetic-recovery');
  const events = [];
  const append = session.append.bind(session);
  session.append = (...args) => { const event = append(...args); events.push(event); return event; };
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const head = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('bootstrap') }, { surfaceOp: 'append' });
  const old = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'historical evidence '.repeat(1000) }], source: { kind: 'synthetic' } }), { surfaceOp: 'append' });
  const current = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('current Self exact') }, { surfaceOp: 'append' });
  const pending = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '/stauts' }], source: { kind: 'synthetic' } }), { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const original = structuredClone(events);
  const plan = { session_id: session.id, original_surface: [...session.surface.nodes], shadowed_seqs: [old.seq], checkpoint_text: '{"carryover":"/stauts"}', budget: { context_tokens: 65536 } };
  const Engine = cognitiveEngineClass(await kernel.load('dsh-compaction'), kernel.llmModule);
  const agent = { session, runMaintenance: task => task(new AbortController().signal) };
  return { kernel, session, events, original, head, current, pending, old, plan, Engine, agent };
}

test('native MNN engine preserves prefix, system, source coverage and durable marker order', { skip: !installed }, async () => {
  const f = await fixture(); let persisted = 0;
  const engine = new f.Engine(f.kernel.ctx, { plan: f.plan, readEvents: async () => [...f.events], persist: async () => { persisted++; }, verifyPlan: async () => {} });
  const result = await engine.compactNow(f.agent, new AbortController().signal);
  assert.equal(f.kernel.ctx.agentLoop.config.maxParallelToolCalls.get(), 1);
  assert.equal(f.session.id, 'synthetic-recovery');
  assert.deepEqual(f.events.slice(0, f.original.length), f.original);
  assert.deepEqual(f.events.slice(f.original.length).map(e => e.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  assert.ok(f.events.at(-2).sourceEventSeqs.includes(f.old.seq));
  assert.ok(f.session.surface.nodes.includes(f.current.seq));
  assert.equal(f.session.deriveMessages().filter(m => m.role === 'system').at(-1).content[0].text, 'current Self exact');
  assert.ok(persisted >= 3 && result.endSeq > result.summarySeq);
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(engine)).constructor.name, 'CompactionEngine');
});

test('plan failure leaves surface untouched and records a closed failed transaction', { skip: !installed }, async () => {
  const f = await fixture(); const before = [...f.session.surface.nodes];
  const engine = new f.Engine(f.kernel.ctx, { plan: f.plan, readEvents: async () => [...f.events], persist: async () => {}, verifyPlan: async () => { throw Error('synthetic-invalid-plan'); } });
  await assert.rejects(engine.compactNow(f.agent, new AbortController().signal), /synthetic-invalid-plan/);
  assert.deepEqual(f.session.surface.nodes, before);
  assert.deepEqual(f.events.slice(f.original.length).map(e => e.type), ['compaction/start', 'compaction/end']);
  assert.ok(f.events.at(-1).data.error);
});

test('cancelled or stale plans never replace history and never invoke a fallback', { skip: !installed }, async () => {
  const f = await fixture(); let verified = false;
  const engine = new f.Engine(f.kernel.ctx, { plan: f.plan, readEvents: async () => [...f.events], persist: async () => {}, verifyPlan: async () => { verified = true; } });
  await assert.rejects(engine.compactNow(f.agent, AbortSignal.abort()), /abort/i);
  assert.equal(verified, false);
  f.plan.original_surface = [];
  await assert.rejects(engine.compactNow(f.agent, new AbortController().signal), /surface-changed/);
  assert.equal(f.events.length, f.original.length);
});

test('nonshrinking checkpoint is rejected before any surface replacement', { skip: !installed }, async () => {
  const f = await fixture(); f.plan.checkpoint_text = 'x'.repeat(100000);
  const engine = new f.Engine(f.kernel.ctx, { plan: f.plan, readEvents: async () => [...f.events], persist: async () => {}, verifyPlan: async () => {} });
  await assert.rejects(engine.compactNow(f.agent, new AbortController().signal), /does-not-reduce/);
  assert.deepEqual(f.session.surface.nodes, f.plan.original_surface);
});
