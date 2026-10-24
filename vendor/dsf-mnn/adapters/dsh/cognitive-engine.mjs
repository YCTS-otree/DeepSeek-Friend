import { randomUUID } from 'node:crypto';

// DSH supplies the interface and pairing guards; policy and checkpoint belong to MNN.
export function cognitiveEngineClass({ CompactionEngine, CompactionId, compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter }, { createUserMessage }) {
  return class MnnCognitiveCompactionEngine extends CompactionEngine {
    constructor(ctx, { plan, readEvents, persist, verifyPlan }) {
      super(ctx);
      this.plan = plan; this.readEvents = readEvents; this.persist = persist; this.verifyPlan = verifyPlan;
    }
    async compactIfNeeded(agent, trigger, signal) {
      signal.throwIfAborted();
      if (this.ctx.tokenMeter.measure(agent.session).totalTokens < this.plan.budget.context_tokens && trigger !== 'context-overflow') return null;
      // Automatic callers use the same MNN policy. There is no Basic fallback.
      return this.perform(agent, signal);
    }
    async compactNow(agent, signal) {
      signal.throwIfAborted();
      return agent.runMaintenance(async maintenanceSignal => this.perform(agent, AbortSignal.any([signal, maintenanceSignal])));
    }
    compactRegion(start, end, agent, signal = new AbortController().signal) {
      if (start !== this.plan.shadowed_seqs[0] || end !== this.plan.shadowed_seqs.at(-1)) throw Error('mnn-plan-range-mismatch');
      return this.perform(agent, signal);
    }
    async perform(agent, signal) {
      const session = agent.session, plan = this.plan;
      signal.throwIfAborted();
      await this.persist(session);
      const events = await this.readEvents(session);
      if (session.id !== plan.session_id || events.length !== session.seq || JSON.stringify(session.surface.nodes) !== JSON.stringify(plan.original_surface)) throw Error('mnn-snapshot-or-surface-changed');
      let owner = null, unmatched = null;
      for (const e of events) {
        if (e.type === 'session/end-seed') unmatched = null;
        if (e.type === 'turn/start') owner = e.data.turn;
        if (e.type === 'turn/end') owner = null;
        if (e.type === 'compaction/start') unmatched = e.data.compactionId;
        if (e.type === 'compaction/end' && e.data.compactionId === unmatched) unmatched = null;
      }
      if (unmatched) throw Error('mnn-compaction-already-active');
      const start = plan.shadowed_seqs[0], end = plan.shadowed_seqs.at(-1);
      if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) throw Error('mnn-unbalanced-tool-boundary');
      const id = CompactionId(randomUUID()), lifecycle = { compactionId: id, turn: owner };
      const startEvent = session.append('compaction/start', lifecycle);
      let closed = false;
      try {
        await this.persist(session); // durable lock precedes plan verification
        await this.verifyPlan(plan, events);
        signal.throwIfAborted();
        if (JSON.stringify(session.surface.nodes) !== JSON.stringify(plan.original_surface)) throw Error('mnn-surface-changed-before-commit');
        const summary = [{ type: 'text', text: plan.checkpoint_text }];
        const shadowedTokenCount = plan.shadowed_seqs.reduce((sum, seq) => {
          const message = session.deriveEventMessage(events[seq]);
          return sum + (message ? this.ctx.tokenMeter.estimateMessage(message) : 0);
        }, 0);
        const checkpointMessage = createUserMessage({ content: summary, source: compactCheckpointSource(id) });
        if (this.ctx.tokenMeter.estimateMessage(checkpointMessage) >= shadowedTokenCount) throw Error('mnn-checkpoint-does-not-reduce-context');
        const summaryEvent = session.append('compaction/summary', { ...lifecycle, summary,
          shadowedRange: { start, end }, shadowedSeqs: plan.shadowed_seqs, shadowedTokenCount,
          provider: 'dsf-mnn', model: 'cognitive-dreaming-acr/1' });
        session.append('user/message', checkpointMessage, {
          surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.shadowed_seqs],
        });
        const endEvent = session.append('compaction/end', lifecycle); closed = true;
        await this.persist(session);
        return { compactionId: id, startSeq: startEvent.seq, summarySeq: summaryEvent.seq, endSeq: endEvent.seq, summary,
          shadowedRange: { start, end }, shadowedSeqs: plan.shadowed_seqs, shadowedTokenCount };
      } catch (error) {
        if (!closed) {
          session.append('compaction/end', { ...lifecycle, error: 'mnn-context-plan-or-commit-failed' });
          await this.persist(session);
        }
        throw error; // failure remains explicit and recoverable; never invoke Basic
      }
    }
  };
}
