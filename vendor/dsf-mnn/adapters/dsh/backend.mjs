import { createHash } from 'node:crypto';

// Factory keeps the research checkout independent of DSH's installation path.
// No service registration: the production host must provide its backup/activation gate.
export function createCognitiveBackend(BasicCompactionEngine, { resolveSnapshot, prepare }) {
  if (typeof resolveSnapshot !== 'function' || typeof prepare !== 'function') throw new Error('mnn-exact-snapshot-resolver-required');
  return class CognitiveCompactionEngine extends BasicCompactionEngine {
    async summarize(input, agent, signal) {
      signal?.throwIfAborted();
      // The public summarize hook lacks source seqs. The host must resolve them exactly.
      const snapshot = await resolveSnapshot(input, agent, signal);
      if (snapshot?.schema !== 'dsf-mnn-snapshot/1' || snapshot.session_id !== agent.session.id || !snapshot.events?.length || !/^[a-f0-9]{64}$/.test(snapshot.digest)) {
        throw new Error('mnn-snapshot-binding-rejected');
      }
      const result = await prepare(structuredClone(snapshot), agent, signal);
      signal?.throwIfAborted();
      if (result.state !== 'prepared' || result.snapshot_digest !== snapshot.digest || !result.summary?.length || result.summary.some(b => b.type !== 'text' || typeof b.text !== 'string')) {
        throw new Error('mnn-checkpoint-not-prepared');
      }
      return { summary: result.summary, provider: result.provider, model: result.model };
    }
  };
}

// Snapshot digest covers normalized events only. Cross-language canonical form
// is produced by Python; the adapter never hashes JSON with a different order.
export function inputFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
