import { BridgeError } from '../util.js';

export function cognitiveConfig(input = {}) {
  const c = {
    enabled: input.enabled ?? true,
    idleExtractionMinutes: input.idleExtractionMinutes ?? 15,
    retrievalTokenBudget: input.retrievalTokenBudget ?? 1600,
    selfTokenBudget: input.selfTokenBudget ?? 12000,
    inputTokenBudget: input.inputTokenBudget ?? 24000,
    outputTokenBudget: input.outputTokenBudget ?? 1800,
    workerTimeoutMs: input.workerTimeoutMs ?? 180000,
    maxAttempts: input.maxAttempts ?? 3,
    dreaming: { enabled: input.dreaming?.enabled ?? true, time: input.dreaming?.time ?? '03:00',
      timezone: input.dreaming?.timezone ?? 'Asia/Shanghai', catchUpOnRestart: input.dreaming?.catchUpOnRestart ?? true },
    provider: input.provider ?? '', model: input.model ?? '',
    reasoningEffort: input.reasoningEffort ?? 'off',
  };
  for (const key of ['idleExtractionMinutes', 'retrievalTokenBudget', 'selfTokenBudget', 'inputTokenBudget', 'outputTokenBudget', 'workerTimeoutMs', 'maxAttempts']) {
    if (!Number.isFinite(c[key]) || c[key] <= 0 || c[key] > (key === 'workerTimeoutMs' ? 3600000 : 100000)) throw new BridgeError('cognitive-config');
  }
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts > 10 || !Number.isInteger(c.outputTokenBudget)
      || c.inputTokenBudget < 2000 || c.selfTokenBudget < 1000 || c.retrievalTokenBudget < 256
      || [c.enabled, c.dreaming.enabled, c.dreaming.catchUpOnRestart].some(x => typeof x !== 'boolean')
      || typeof c.dreaming.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.dreaming.time)
      || typeof c.provider !== 'string' || typeof c.model !== 'string' || Boolean(c.provider) !== Boolean(c.model)
      || typeof c.reasoningEffort !== 'string' || !/^[a-z0-9_-]{0,40}$/i.test(c.reasoningEffort)) throw new BridgeError('cognitive-config');
  try { new Intl.DateTimeFormat('en', { timeZone: c.dreaming.timezone }).format(); } catch { throw new BridgeError('cognitive-timezone'); }
  return c;
}
